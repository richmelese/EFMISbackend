import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Role } from '../../../common/constants/permissions';
import { sha256 } from '../../../common/utils/helpers';
import { AlertsService } from '../../alerts/alerts.service';
import { Alert } from '../../alerts/entities/alert.entity';
import { AuditService } from '../../audit/audit.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SettingsService } from '../../settings/settings.service';
import { HotStateService } from '../jobs/hot-state.service';
import { logisticsThresholds } from '../logistics.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { Driver, DriverDocument } from './entities/driver.entities';
import { addDaysYmd, daysBetween, docValidThrough, ymd } from './drivers.util';

export interface ComplianceScanSummary {
  at: string;
  asOf: string;
  warningDays: number;
  scannedDrivers: number;
  documentsExpired: number;
  driversMarkedDocumentExpired: number;
  expiringItems: number;
  remindersSent: number;
  alertsRaised: number;
  errors: number;
}

interface ExpiryItem {
  kind: 'LICENCE' | 'CERTIFICATION' | 'DOCUMENT';
  ref: string;
  label: string;
  expiresAt: string;
}

const REMINDER_DAYS = [30, 14, 7, 1];

/**
 * Driver compliance (Logistics doc §6 step 16, §7 "Expiry dashboard and reminders"):
 * expires documents, marks drivers DOCUMENT_EXPIRED, sends 30/14/7/1-day reminders to logistics managers and raises
 * 'Driver Compliance' alerts. Runs hourly when the scheduler is enabled; `runComplianceScan()` is callable directly.
 * Never logs licence numbers or document contents.
 */
@Injectable()
export class DriverComplianceService {
  private readonly logger = new Logger('DriverCompliance');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly notifications: NotificationsService,
    private readonly hot: HotStateService,
    private readonly realtime: RealtimeService
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'driver-compliance-scan' })
  async scheduledScan(): Promise<void> {
    if (!this.config.get<boolean>('schedulerEnabled')) return;
    // one instance at a time across replicas (Redis) / overlapping ticks (memory)
    if (!(await this.hot.setOnce('lock:driver-compliance-scan', 15 * 60))) return;
    try {
      const s = await this.runComplianceScan();
      this.logger.log(`Driver compliance scan: ${s.scannedDrivers} drivers, ${s.documentsExpired} documents expired, ` +
        `${s.driversMarkedDocumentExpired} drivers marked DOCUMENT_EXPIRED, ${s.remindersSent} reminders, ${s.alertsRaised} alerts, ${s.errors} errors`);
    } catch (e) {
      this.logger.error(`Driver compliance scan failed: ${e?.message ?? e}`);
    } finally {
      await this.hot.del('lock:driver-compliance-scan');
    }
  }

  async runComplianceScan(): Promise<ComplianceScanSummary> {
    const warningDays = (await logisticsThresholds(this.settings)).documentExpiryWarningDays;
    const today = ymd();
    const horizon = addDaysYmd(today, Math.max(warningDays, ...REMINDER_DAYS));
    const thresholds = [...new Set([warningDays, ...REMINDER_DAYS])].filter(n => n > 0).sort((a, b) => a - b);
    const summary: ComplianceScanSummary = {
      at: new Date().toISOString(), asOf: today, warningDays, scannedDrivers: 0, documentsExpired: 0, driversMarkedDocumentExpired: 0,
      expiringItems: 0, remindersSent: 0, alertsRaised: 0, errors: 0
    };

    const ids = (await this.ds.getRepository(Driver).find({ select: { id: true } })).map(d => d.id);
    for (const id of ids) {
      summary.scannedDrivers++;
      try {
        const out = await this.ds.transaction(async m => {
          const d = await m.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
          if (!d) return null;
          const docRepo = m.getRepository(DriverDocument);
          const docs = await docRepo.find({ where: { driverId: id } });
          const name = `${d.firstName} ${d.lastName}`.trim();

          // 1. documents past their expiry date
          for (const doc of docs) {
            if (!doc.expiresAt || doc.expiresAt >= today || ['EXPIRED', 'REJECTED'].includes(doc.verificationStatus)) continue;
            const old = doc.verificationStatus;
            await docRepo.update({ id: doc.id }, { verificationStatus: 'EXPIRED' });
            doc.verificationStatus = 'EXPIRED';
            summary.documentsExpired++;
            await this.audit.record(null, 'DRIVER_DOCUMENT_EXPIRED', d.id, {
              documentId: doc.id, documentType: doc.documentType, expiresAt: doc.expiresAt, old: { verificationStatus: old }, new: { verificationStatus: 'EXPIRED' }
            }, { source: 'SCHEDULER' }, m);
          }

          // 2. licence / required LICENCE document expired -> DOCUMENT_EXPIRED (never while ON_TRIP)
          const licenceExpired = !d.licenceExpiryDate || d.licenceExpiryDate < today;
          const licenceDocs = docs.filter(x => x.documentType === 'LICENCE');
          const licenceDocExpired = licenceDocs.length > 0 && !licenceDocs.some(x => docValidThrough(x, today)) && licenceDocs.some(x => x.verificationStatus === 'EXPIRED');
          let availabilityChange: { previous: string; next: string } | null = null;
          if ((licenceExpired || licenceDocExpired) && !['ON_TRIP', 'DOCUMENT_EXPIRED'].includes(d.availabilityStatus)) {
            availabilityChange = { previous: d.availabilityStatus, next: 'DOCUMENT_EXPIRED' };
            await m.getRepository(Driver).update({ id: d.id }, { availabilityStatus: 'DOCUMENT_EXPIRED' });
            summary.driversMarkedDocumentExpired++;
            await this.audit.record(null, 'DRIVER_MARKED_DOCUMENT_EXPIRED', d.id, {
              old: { availabilityStatus: availabilityChange.previous }, new: { availabilityStatus: 'DOCUMENT_EXPIRED' },
              reason: licenceExpired ? `Driving licence expired on ${d.licenceExpiryDate}` : 'Required LICENCE document expired'
            }, { source: 'SCHEDULER' }, m);
          }

          // 3. reminders + alerts for everything expiring within the window
          const items: ExpiryItem[] = [];
          if (d.licenceExpiryDate) items.push({ kind: 'LICENCE', ref: 'licence', label: 'Driving licence', expiresAt: d.licenceExpiryDate });
          for (const c of d.certifications || []) {
            if (c?.expiresAt) items.push({ kind: 'CERTIFICATION', ref: sha256(c.name).slice(0, 10), label: `Certification "${c.name}"`, expiresAt: c.expiresAt });
          }
          for (const doc of docs) {
            if (doc.expiresAt && doc.verificationStatus !== 'REJECTED') items.push({ kind: 'DOCUMENT', ref: doc.id, label: `${doc.documentType} document`, expiresAt: doc.expiresAt });
          }

          const newAlerts: any[] = [];
          for (const item of items.filter(x => x.expiresAt <= horizon)) {
            const days = daysBetween(today, item.expiresAt);
            const expired = days < 0;
            summary.expiringItems++;
            const when = expired ? `expired on ${item.expiresAt}` : days === 0 ? `expires today (${item.expiresAt})` : `expires on ${item.expiresAt} (${days} day${days === 1 ? '' : 's'})`;

            if (expired || days <= warningDays) {
              const dedupeKey = `driver-compliance:${d.id}:${item.kind}:${item.ref}:${item.expiresAt}`.slice(0, 160);
              const existed = await m.getRepository(Alert).exist({ where: { dedupeKey } });
              const alert = await this.alerts.raise({
                severity: 'MEDIUM_YELLOW',
                title: `${item.label} ${expired ? 'expired' : 'expiring'}: ${name} (${d.employeeNumber})`.slice(0, 240),
                category: 'Driver Compliance',
                trigger: `${item.label} of driver ${name} (${d.employeeNumber}) ${when}`,
                affectedArea: d.employer || 'Fleet',
                actionRequired: 'Renew the document, upload the new copy and verify it before assigning the driver',
                sourceType: 'DRIVER',
                sourceId: d.id,
                dedupeKey
              }, m);
              if (!existed) { summary.alertsRaised++; newAlerts.push(alert); }
            }

            const bucket = expired ? 'expired' : thresholds.find(t => days <= t);
            if (bucket === undefined) continue;
            const gate = `driver-expiry-reminder:${d.id}:${item.kind}:${item.ref}:${item.expiresAt}:${bucket}`;
            if (!(await this.hot.setOnce(gate, 45 * 864e2))) continue;
            await this.notifications.notify({
              role: Role.LOGISTICS_MANAGER,
              title: `Driver compliance: ${item.label} ${expired ? 'expired' : 'expiring'} — ${name}`,
              message: `${item.label} of driver ${name} (${d.employeeNumber}) ${when}.`,
              link: `/logistics/drivers/${d.id}`
            }, m);
            summary.remindersSent++;
          }
          return { d, availabilityChange, newAlerts };
        });
        if (!out) continue;
        if (out.availabilityChange) {
          this.realtime.publish('driver.assignment.updated', { driverId: out.d.id }, {
            driverId: out.d.id, employeeNumber: out.d.employeeNumber, name: `${out.d.firstName} ${out.d.lastName}`.trim(),
            previousAvailabilityStatus: out.availabilityChange.previous, availabilityStatus: out.availabilityChange.next, tripId: null,
            reason: 'DOCUMENT_EXPIRED'
          });
        }
        for (const a of out.newAlerts) this.realtime.publish('alert.created', { driverId: out.d.id, alertId: a.id }, a);
      } catch (e) {
        summary.errors++;
        this.logger.warn(`Compliance scan failed for driver ${id}: ${e?.message ?? e}`);
      }
    }
    return summary;
  }
}
