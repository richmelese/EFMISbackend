import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, LessThan, LessThanOrEqual, MoreThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { can, Role } from '../../../common/constants/permissions';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { ACTIVE_TRIP_STATES, MOVING_TRIP_STATES } from '../../../common/utils/state-machine';
import { applySearch } from '../../../common/utils/query-filters';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../../settings/settings.service';
import { User } from '../../users/entities/user.entity';
import { VehicleType } from '../fleet/entities/fleet.entities';
import { logisticsThresholds, Paged, pageParams } from '../logistics.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { Delivery, Shipment, Trip, TripEvent, TripShipment } from '../shipments/entities/shipment.entities';
import { DriverComplianceService, ComplianceScanSummary } from './driver-compliance.service';
import { PageQueryDto } from '../../../common/dto/pagination.dto';
import {
  AvailabilityQueryDto, CreateAvailabilityDto, CreateDriverDto, EligibleQueryDto, ListDriversQueryDto, PerformanceQueryDto,
  ReactivateDriverDto, SuspendDriverDto, UpdateDriverDto, VerifyDriverDto
} from './dto/driver.dto';
import { Driver, DriverAvailability, DriverDocument, DriverTripAssignment } from './entities/driver.entities';
import {
  addDaysYmd, daysBetween, docToFrontend, docValidThrough, EligibilityData, evaluateEligibility, iso, maskLicence, restingAvailability, uniqueViolation, ymd
} from './drivers.util';

export interface CurrentTripRef {
  id: string;
  tripNumber: string;
  status: string;
  truckId: string;
}

export interface DriverViewOpts {
  sensitive?: boolean;
  currentTrip?: CurrentTripRef | null;
  documentsExpiringSoon?: boolean;
}

type AvailabilityTarget = 'AVAILABLE' | 'ASSIGNED' | 'ON_TRIP';

/** Driver management (Logistics doc §6/§7): records, verification, availability, eligibility, history and KPIs. */
@Injectable()
export class DriversService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Driver) readonly drivers: Repository<Driver>,
    @InjectRepository(DriverDocument) private readonly documents: Repository<DriverDocument>,
    @InjectRepository(DriverAvailability) private readonly windows: Repository<DriverAvailability>,
    @InjectRepository(DriverTripAssignment) private readonly assignments: Repository<DriverTripAssignment>,
    @InjectRepository(VehicleType) private readonly vehicleTypes: Repository<VehicleType>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripShipment) private readonly tripShipments: Repository<TripShipment>,
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    @InjectRepository(Delivery) private readonly deliveries: Repository<Delivery>,
    @InjectRepository(TripEvent) private readonly tripEvents: Repository<TripEvent>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeService,
    private readonly compliance: DriverComplianceService
  ) {}

  // ------------------------------------------------------------------ contract methods (LOGISTICS.md)

  /** API shape of a driver. licenceNumber is masked ('****1234') unless `sensitive`. */
  toFrontend(d: Driver, opts: DriverViewOpts = {}): any {
    const today = ymd();
    return {
      id: d.id,
      employeeNumber: d.employeeNumber,
      name: `${d.firstName} ${d.lastName}`.trim(),
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      email: d.email,
      licenceNumber: opts.sensitive ? d.licenceNumber : maskLicence(d.licenceNumber),
      licenceNumberMasked: !opts.sensitive,
      licenceClass: d.licenceClass,
      licenceExpiryDate: d.licenceExpiryDate,
      licenceExpired: !d.licenceExpiryDate || d.licenceExpiryDate < today,
      verificationStatus: d.verificationStatus,
      employmentStatus: d.employmentStatus,
      availabilityStatus: d.availabilityStatus,
      documentsExpiringSoon: opts.documentsExpiringSoon ?? false,
      currentTrip: opts.currentTrip ?? null,
      certifications: d.certifications || [],
      emergencyContactName: d.emergencyContactName,
      emergencyContactPhone: d.emergencyContactPhone,
      employer: d.employer,
      userId: d.userId,
      suspensionReason: d.suspensionReason,
      createdAt: iso(d.createdAt),
      updatedAt: iso(d.updatedAt)
    };
  }

  /** Driver record linked to a login account (DRIVER role scoping). */
  async driverForUser(userId: string): Promise<Driver | null> {
    if (!userId) return null;
    return this.drivers.findOne({ where: { userId } });
  }

  /** Assignment eligibility for [from, to] (see LOGISTICS.md for the required reasons). */
  async checkEligibility(
    driverId: string,
    ctx: { vehicleTypeId?: string | null; from: Date; to: Date; excludeTripId?: string },
    manager?: EntityManager
  ): Promise<{ eligible: boolean; reasons: string[] }> {
    const m = manager ?? this.ds.manager;
    const d = await m.getRepository(Driver).findOne({ where: { id: driverId } });
    if (!d) return { eligible: false, reasons: ['Driver not found'] };
    const data = (await this.loadEligibilityData([d.id], ctx.from, ctx.to, m)).get(d.id)!;
    if (ctx.vehicleTypeId) data.vehicleType = (await m.getRepository(VehicleType).findOne({ where: { id: ctx.vehicleTypeId } })) ?? null;
    const reasons = evaluateEligibility(d, data, ctx);
    return { eligible: reasons.length === 0, reasons };
  }

  /**
   * Availability change driven by trip assignment (called by trips/dispatch inside their transaction).
   * 'AVAILABLE' means "released": the driver returns to the resting state his employment / verification /
   * licence allow (AVAILABLE, UNAVAILABLE or DOCUMENT_EXPIRED). Audited; publishes driver.assignment.updated.
   */
  async setAvailability(driverId: string, status: AvailabilityTarget, manager?: EntityManager): Promise<void> {
    const work = async (m: EntityManager) => {
      const repo = m.getRepository(Driver);
      const d = await repo.findOne({ where: { id: driverId }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw Errors.notFound('Driver');
      const previous = d.availabilityStatus;
      let next: string = status;
      if (status === 'AVAILABLE') {
        const licenceDocs = await m.getRepository(DriverDocument).find({ where: { driverId, documentType: 'LICENCE' } });
        next = restingAvailability(d, licenceDocs.some(x => docValidThrough(x, ymd())));
      }
      if (next === previous) return null;
      await repo.update({ id: d.id }, { availabilityStatus: next });
      await this.audit.record(null, 'DRIVER_AVAILABILITY_CHANGED', d.id, { old: { availabilityStatus: previous }, new: { availabilityStatus: next }, requested: status }, { source: 'SYSTEM' }, m);
      const active = await m.getRepository(DriverTripAssignment).findOne({ where: { driverId, status: 'ACTIVE' } });
      return { d, previous, next, tripId: active?.tripId ?? null };
    };
    // row locks need a transaction: reuse the caller's, otherwise open one
    const changed = manager?.queryRunner?.isTransactionActive ? await work(manager) : await this.ds.transaction(work);
    if (changed) this.publishAvailability(changed.d, changed.previous, changed.next, changed.tripId);
  }

  /** Compliance scan (licence/document expiry, reminders, alerts) — also run hourly by the scheduler. */
  runComplianceScan(): Promise<ComplianceScanSummary> {
    return this.compliance.runComplianceScan();
  }

  // ------------------------------------------------------------------ helpers

  private isSensitive(user: AuthUser) {
    return can(user, 'drivers:sensitive');
  }

  private assertFleetWide(user: AuthUser) {
    if (user.role === Role.DRIVER) throw Errors.forbidden('Drivers can only access their own record');
  }

  /** Load a driver the caller may read (DRIVER role: own record only). */
  async readable(user: AuthUser, id: string): Promise<Driver> {
    const d = await this.drivers.findOne({ where: { id } });
    if (!d) throw Errors.notFound('Driver');
    if (user.role === Role.DRIVER && d.userId !== user.id) throw Errors.forbidden('Drivers can only access their own record');
    return d;
  }

  private async lockDriver(m: EntityManager, id: string): Promise<Driver> {
    const d = await m.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!d) throw Errors.notFound('Driver');
    return d;
  }

  private publishAvailability(d: Driver, previous: string, next: string, tripId: string | null) {
    this.realtime.publish('driver.assignment.updated', { driverId: d.id, tripId }, {
      driverId: d.id, employeeNumber: d.employeeNumber, name: `${d.firstName} ${d.lastName}`.trim(),
      previousAvailabilityStatus: previous, availabilityStatus: next, tripId
    });
  }

  private async warningDays(): Promise<number> {
    return (await logisticsThresholds(this.settings)).documentExpiryWarningDays;
  }

  private parseRange(q: { from?: string; to?: string }, defaultHours = 24) {
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + defaultHours * 36e5);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw Errors.unprocessable('Invalid from/to');
    if (to <= from) throw Errors.unprocessable('"to" must be after "from"');
    return { from, to };
  }

  /** Batch-load documents, overlapping availability windows and active assignments for eligibility checks. */
  private async loadEligibilityData(ids: string[], from: Date, to: Date, m: EntityManager = this.ds.manager): Promise<Map<string, EligibilityData>> {
    const out = new Map<string, EligibilityData>(ids.map(id => [id, { docs: [], windows: [], activeAssignments: [] }]));
    if (!ids.length) return out;
    const [docs, windows, actives] = await Promise.all([
      m.getRepository(DriverDocument).find({ where: { driverId: In(ids) } }),
      m.getRepository(DriverAvailability).find({ where: { driverId: In(ids), startAt: LessThan(to), endAt: MoreThan(from) }, order: { startAt: 'ASC' } }),
      m.getRepository(DriverTripAssignment).find({ where: { driverId: In(ids), status: 'ACTIVE' } })
    ]);
    for (const x of docs) out.get(x.driverId)?.docs.push(x);
    for (const x of windows) out.get(x.driverId)?.windows.push(x);
    for (const x of actives) out.get(x.driverId)?.activeAssignments.push(x);
    return out;
  }

  /** Current trip + "documents expiring soon" flag for a set of drivers (list/detail views). */
  private async enrich(list: Driver[], warningDays: number) {
    const ids = list.map(d => d.id);
    const res = new Map<string, { currentTrip: CurrentTripRef | null; documentsExpiringSoon: boolean }>();
    if (!ids.length) return res;
    const horizon = addDaysYmd(ymd(), warningDays);
    const [actives, primaryTrips, expiringDocs] = await Promise.all([
      this.assignments.find({ where: { driverId: In(ids), status: 'ACTIVE' } }),
      this.trips.find({ where: { primaryDriverId: In(ids), status: In(ACTIVE_TRIP_STATES) } }),
      this.documents.find({ where: { driverId: In(ids), expiresAt: LessThanOrEqual(horizon), verificationStatus: Not('REJECTED') } })
    ]);
    const assignedTripIds = actives.map(a => a.tripId).filter(id => !primaryTrips.some(t => t.id === id));
    const assignedTrips = assignedTripIds.length ? await this.trips.find({ where: { id: In(assignedTripIds) } }) : [];
    const tripById = new Map([...primaryTrips, ...assignedTrips].map(t => [t.id, t]));
    for (const d of list) {
      const a = actives.find(x => x.driverId === d.id);
      const t = (a && tripById.get(a.tripId)) || primaryTrips.find(x => x.primaryDriverId === d.id) || null;
      const certExpiring = (d.certifications || []).some(c => c?.expiresAt && c.expiresAt <= horizon);
      res.set(d.id, {
        currentTrip: t ? { id: t.id, tripNumber: t.tripNumber, status: t.status, truckId: t.truckId } : null,
        documentsExpiringSoon: (d.licenceExpiryDate <= horizon) || certExpiring || expiringDocs.some(x => x.driverId === d.id)
      });
    }
    return res;
  }

  private async view(user: AuthUser, list: Driver[]) {
    const extra = await this.enrich(list, await this.warningDays());
    const sensitive = this.isSensitive(user);
    return list.map(d => this.toFrontend(d, { sensitive, ...extra.get(d.id) }));
  }

  private async hasValidLicenceDoc(m: EntityManager, driverId: string, onDate = ymd()) {
    const docs = await m.getRepository(DriverDocument).find({ where: { driverId, documentType: 'LICENCE' } });
    return docs.some(x => docValidThrough(x, onDate));
  }

  /** Checks required before a driver may be (re)verified / reactivated. */
  private async verificationGaps(m: EntityManager, d: Driver): Promise<string[]> {
    const gaps: string[] = [];
    if (!d.licenceExpiryDate || d.licenceExpiryDate <= ymd()) gaps.push('Licence expiry date must be in the future');
    if (!(await this.hasValidLicenceDoc(m, d.id))) gaps.push('A VERIFIED, non-expired LICENCE document is required');
    return gaps;
  }

  private snapshot(d: Driver) {
    // audit snapshots never contain the full licence number
    const v = this.toFrontend(d);
    delete v.createdAt;
    delete v.updatedAt;
    delete v.currentTrip;
    delete v.documentsExpiringSoon;
    return v;
  }

  private async assertUnique(m: EntityManager, field: 'employeeNumber' | 'licenceNumber', value: string, excludeId?: string) {
    const qb = m.getRepository(Driver).createQueryBuilder('d').where(`UPPER(d.${field}) = UPPER(:v)`, { v: value });
    if (excludeId) qb.andWhere('d.id <> :id', { id: excludeId });
    if (await qb.getExists()) {
      throw Errors.conflict(field === 'employeeNumber' ? 'Employee number already exists' : 'Licence number is already registered to another driver', { field });
    }
  }

  private normaliseLicence = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '');

  // ------------------------------------------------------------------ CRUD

  async list(user: AuthUser, q: ListDriversQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.drivers.createQueryBuilder('d');
    if (user.role === Role.DRIVER) {
      const own = await this.driverForUser(user.id);
      if (!own) return { items: [], total: 0, page, pageSize };
      qb.andWhere('d.id = :own', { own: own.id });
    }
    applySearch(qb, ['d.firstName', 'd.lastName', `(d.firstName || ' ' || d.lastName)`, 'd.employeeNumber', 'd.phone'], q.q?.trim());
    switch (q.status) {
      case 'available': qb.andWhere(`d.availabilityStatus = 'AVAILABLE'`); break;
      case 'assigned': qb.andWhere(`d.availabilityStatus = 'ASSIGNED'`); break;
      case 'on_trip': qb.andWhere(`d.availabilityStatus = 'ON_TRIP'`); break;
      case 'unverified': qb.andWhere(`d.verificationStatus <> 'VERIFIED'`); break;
      case 'inactive': qb.andWhere(`d.employmentStatus IN ('INACTIVE', 'ON_LEAVE')`); break;
      case 'suspended': qb.andWhere(`d.employmentStatus = 'SUSPENDED'`); break;
      case 'document_expiring': {
        const horizon = addDaysYmd(ymd(), await this.warningDays());
        qb.andWhere(new Brackets(b => b
          .where('d.licenceExpiryDate <= :horizon', { horizon })
          .orWhere(`d.availabilityStatus = 'DOCUMENT_EXPIRED'`)
          .orWhere(`EXISTS (SELECT 1 FROM driver_documents dd WHERE dd.driver_id = d.id AND dd.expires_at IS NOT NULL AND dd.expires_at <= :horizon AND dd.verification_status <> 'REJECTED')`, { horizon })
          .orWhere(`EXISTS (SELECT 1 FROM jsonb_array_elements(d.certifications) c WHERE COALESCE(c->>'expiresAt', '') <> '' AND c->>'expiresAt' <= :horizonTxt)`, { horizonTxt: horizon })));
        break;
      }
    }
    const [rows, total] = await qb.orderBy('d.lastName', 'ASC').addOrderBy('d.firstName', 'ASC').skip(skip).take(take).getManyAndCount();
    return { items: await this.view(user, rows), total, page, pageSize };
  }

  async create(user: AuthUser, dto: CreateDriverDto, ctx: RequestContext) {
    const today = ymd();
    if (dto.licenceExpiryDate <= today) throw Errors.unprocessable('licenceExpiryDate must be in the future', { field: 'licenceExpiryDate' });
    const employeeNumber = dto.employeeNumber.trim();
    const licenceNumber = this.normaliseLicence(dto.licenceNumber);
    try {
      const saved = await this.ds.transaction(async m => {
        await this.assertUnique(m, 'employeeNumber', employeeNumber);
        await this.assertUnique(m, 'licenceNumber', licenceNumber);
        const repo = m.getRepository(Driver);
        const d = await repo.save(repo.create({
          employeeNumber, firstName: dto.firstName.trim(), lastName: dto.lastName.trim(), phone: dto.phone, email: dto.email?.trim() || null,
          licenceNumber, licenceClass: dto.licenceClass, licenceExpiryDate: dto.licenceExpiryDate,
          verificationStatus: 'PENDING_VERIFICATION', employmentStatus: dto.employmentStatus || 'ACTIVE', availabilityStatus: 'UNAVAILABLE',
          certifications: (dto.certifications || []).map(c => ({ name: c.name.trim(), expiresAt: c.expiresAt || null })),
          emergencyContactName: dto.emergencyContactName ?? null, emergencyContactPhone: dto.emergencyContactPhone ?? null,
          employer: dto.employer ?? null, userId: null, suspensionReason: null
        }));
        await this.audit.record(user, 'DRIVER_CREATED', d.id, { old: null, new: this.snapshot(d) }, ctx, m);
        return d;
      });
      return (await this.view(user, [saved]))[0];
    } catch (e) {
      const msg = uniqueViolation(e);
      if (msg) throw Errors.conflict(msg);
      throw e;
    }
  }

  async detail(user: AuthUser, id: string) {
    const d = await this.readable(user, id);
    const warn = await this.warningDays();
    const [base] = await this.view(user, [d]);
    const [docs, upcoming, active, recent] = await Promise.all([
      this.documents.find({ where: { driverId: id }, order: { createdAt: 'DESC' } }),
      this.windows.find({ where: { driverId: id, endAt: MoreThanOrEqual(new Date()) }, order: { startAt: 'ASC' }, take: 20 }),
      this.assignments.findOne({ where: { driverId: id, status: 'ACTIVE' } }),
      this.assignments.find({ where: { driverId: id }, order: { assignedAt: 'DESC' }, take: 5 })
    ]);
    const tripIds = [...new Set([...(active ? [active.tripId] : []), ...recent.map(a => a.tripId)])];
    const trips = tripIds.length ? await this.trips.find({ where: { id: In(tripIds) } }) : [];
    const tripRef = (tid: string) => {
      const t = trips.find(x => x.id === tid);
      return t ? this.tripSummary(t) : { id: tid };
    };
    const docViews = docs.map(x => docToFrontend(x, warn));
    return {
      ...base,
      documents: {
        total: docs.length,
        verified: docs.filter(x => x.verificationStatus === 'VERIFIED').length,
        pending: docs.filter(x => x.verificationStatus === 'PENDING').length,
        rejected: docs.filter(x => x.verificationStatus === 'REJECTED').length,
        expired: docViews.filter(x => x.expired).length,
        expiringSoon: docViews.filter(x => x.expiringSoon).length,
        hasValidLicenceDocument: docs.some(x => x.documentType === 'LICENCE' && docValidThrough(x, ymd())),
        items: docViews
      },
      upcomingAvailability: upcoming.map(w => this.windowToFrontend(w)),
      activeAssignment: active ? this.assignmentToFrontend(active, tripRef(active.tripId)) : null,
      recentTrips: recent.map(a => this.assignmentToFrontend(a, tripRef(a.tripId)))
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateDriverDto, ctx: RequestContext) {
    let published: { d: Driver; previous: string; next: string; tripId: string | null } | null = null;
    try {
      const saved = await this.ds.transaction(async m => {
        const d = await this.lockDriver(m, id);
        const before = this.snapshot(d);
        const prevAvailability = d.availabilityStatus;
        const active = await m.getRepository(DriverTripAssignment).findOne({ where: { driverId: id, status: 'ACTIVE' } });
        const changed: string[] = [];
        const set = <K extends keyof Driver>(k: K, v: Driver[K] | undefined) => {
          if (v === undefined) return;
          if (JSON.stringify(d[k]) !== JSON.stringify(v)) { d[k] = v; changed.push(String(k)); }
        };

        if (dto.employeeNumber !== undefined) {
          const v = dto.employeeNumber.trim();
          if (v.toUpperCase() !== d.employeeNumber.toUpperCase()) await this.assertUnique(m, 'employeeNumber', v, id);
          set('employeeNumber', v);
        }
        set('firstName', dto.firstName?.trim());
        set('lastName', dto.lastName?.trim());
        set('phone', dto.phone);
        if (dto.email !== undefined) set('email', dto.email?.trim() || null);
        if (dto.certifications !== undefined) set('certifications', dto.certifications.map(c => ({ name: c.name.trim(), expiresAt: c.expiresAt || null })));
        if (dto.emergencyContactName !== undefined) set('emergencyContactName', dto.emergencyContactName || null);
        if (dto.emergencyContactPhone !== undefined) set('emergencyContactPhone', dto.emergencyContactPhone || null);
        if (dto.employer !== undefined) set('employer', dto.employer || null);

        // licence data
        let licenceChanged = false;
        if (dto.licenceNumber !== undefined) {
          const v = this.normaliseLicence(dto.licenceNumber);
          if (v !== d.licenceNumber) {
            await this.assertUnique(m, 'licenceNumber', v, id);
            d.licenceNumber = v; changed.push('licenceNumber'); licenceChanged = true;
          }
        }
        if (dto.licenceClass !== undefined && dto.licenceClass !== d.licenceClass) { d.licenceClass = dto.licenceClass; changed.push('licenceClass'); licenceChanged = true; }
        if (dto.licenceExpiryDate !== undefined && dto.licenceExpiryDate !== d.licenceExpiryDate) {
          if (dto.licenceExpiryDate <= ymd()) throw Errors.unprocessable('licenceExpiryDate must be in the future', { field: 'licenceExpiryDate' });
          d.licenceExpiryDate = dto.licenceExpiryDate; changed.push('licenceExpiryDate'); licenceChanged = true;
        }
        if (licenceChanged) {
          d.verificationStatus = 'PENDING_VERIFICATION';
          // a driver committed to a trip keeps ASSIGNED/ON_TRIP; release returns him to UNAVAILABLE until re-verified
          if (!['ASSIGNED', 'ON_TRIP'].includes(d.availabilityStatus)) d.availabilityStatus = 'UNAVAILABLE';
        }

        // employment (SUSPENDED only via suspend / reactivate)
        if (dto.employmentStatus !== undefined && dto.employmentStatus !== d.employmentStatus) {
          if (d.employmentStatus === 'SUSPENDED') throw Errors.conflict('Driver is suspended — use POST /drivers/:id/reactivate');
          if (dto.employmentStatus !== 'ACTIVE' && (active || ['ASSIGNED', 'ON_TRIP'].includes(d.availabilityStatus))) {
            throw Errors.conflict('Driver has an active trip assignment — release or reassign it before changing employment status', { tripId: active?.tripId });
          }
          d.employmentStatus = dto.employmentStatus;
          changed.push('employmentStatus');
          if (dto.employmentStatus !== 'ACTIVE') d.availabilityStatus = 'UNAVAILABLE';
          else if (!['ASSIGNED', 'ON_TRIP'].includes(d.availabilityStatus)) d.availabilityStatus = restingAvailability(d, await this.hasValidLicenceDoc(m, id));
        }

        // login account link
        if (dto.userId !== undefined && dto.userId !== d.userId) {
          if (dto.userId !== null) {
            const u = await m.getRepository(User).findOne({ where: { id: dto.userId } });
            if (!u) throw Errors.unprocessable('User account not found', { field: 'userId' });
            if (u.role !== Role.DRIVER) throw Errors.unprocessable(`User account must have role DRIVER (has ${u.role})`, { field: 'userId' });
            const other = await m.getRepository(Driver).findOne({ where: { userId: dto.userId } });
            if (other && other.id !== id) throw Errors.conflict('This user account is already linked to another driver');
          }
          d.userId = dto.userId;
          changed.push('userId');
        }

        if (!changed.length) return d;
        await m.getRepository(Driver).save(d);
        await this.audit.record(user, 'DRIVER_UPDATED', d.id, {
          old: before, new: this.snapshot(d), changed, licenceChanged, reason: dto.reason ?? null
        }, ctx, m);
        if (d.availabilityStatus !== prevAvailability) published = { d, previous: prevAvailability, next: d.availabilityStatus, tripId: active?.tripId ?? null };
        return d;
      });
      if (published) {
        const p = published as { d: Driver; previous: string; next: string; tripId: string | null };
        this.publishAvailability(p.d, p.previous, p.next, p.tripId);
      }
      return (await this.view(user, [saved]))[0];
    } catch (e) {
      const msg = uniqueViolation(e);
      if (msg) throw Errors.conflict(msg);
      throw e;
    }
  }

  // ------------------------------------------------------------------ verification / employment

  async verify(user: AuthUser, id: string, dto: VerifyDriverDto, ctx: RequestContext) {
    const res = await this.ds.transaction(async m => {
      const d = await this.lockDriver(m, id);
      const gaps = await this.verificationGaps(m, d);
      if (gaps.length) throw Errors.unprocessable('Driver cannot be verified — required checks failed', { missingChecks: gaps });
      const before = { verificationStatus: d.verificationStatus, availabilityStatus: d.availabilityStatus };
      const active = await m.getRepository(DriverTripAssignment).findOne({ where: { driverId: id, status: 'ACTIVE' } });
      d.verificationStatus = 'VERIFIED';
      if (!active && !['ASSIGNED', 'ON_TRIP'].includes(d.availabilityStatus)) {
        d.availabilityStatus = d.employmentStatus === 'ACTIVE' ? 'AVAILABLE' : 'UNAVAILABLE';
      }
      await m.getRepository(Driver).save(d);
      await this.audit.record(user, 'DRIVER_VERIFIED', d.id, {
        old: before, new: { verificationStatus: d.verificationStatus, availabilityStatus: d.availabilityStatus }, reason: dto.notes ?? null
      }, ctx, m);
      return { d, previous: before.availabilityStatus, tripId: active?.tripId ?? null };
    });
    if (res.previous !== res.d.availabilityStatus) this.publishAvailability(res.d, res.previous, res.d.availabilityStatus, res.tripId);
    return (await this.view(user, [res.d]))[0];
  }

  async suspend(user: AuthUser, id: string, dto: SuspendDriverDto, ctx: RequestContext) {
    const res = await this.ds.transaction(async m => {
      const d = await this.lockDriver(m, id);
      if (d.employmentStatus === 'SUSPENDED') throw Errors.conflict('Driver is already suspended');
      const active = await m.getRepository(DriverTripAssignment).findOne({ where: { driverId: id, status: 'ACTIVE' } });
      const activeTrip = active ? await m.getRepository(Trip).findOne({ where: { id: active.tripId } }) : null;
      if (d.availabilityStatus === 'ON_TRIP' || (activeTrip && MOVING_TRIP_STATES.includes(activeTrip.status))) {
        throw Errors.conflict('Driver is on a trip — suspension is not allowed until the trip ends', { tripId: active?.tripId ?? null });
      }
      const before = { employmentStatus: d.employmentStatus, availabilityStatus: d.availabilityStatus, suspensionReason: d.suspensionReason };
      d.employmentStatus = 'SUSPENDED';
      d.suspensionReason = dto.reason.trim();
      // availability is kept separate: a planned (not yet dispatched) assignment stays visible as ASSIGNED and fails re-validation
      if (!active && d.availabilityStatus !== 'ASSIGNED') d.availabilityStatus = 'UNAVAILABLE';
      await m.getRepository(Driver).save(d);
      await this.audit.record(user, 'DRIVER_SUSPENDED', d.id, {
        old: before, new: { employmentStatus: d.employmentStatus, availabilityStatus: d.availabilityStatus }, reason: d.suspensionReason
      }, ctx, m);
      return { d, previous: before.availabilityStatus, active, activeTrip };
    });
    if (res.previous !== res.d.availabilityStatus) this.publishAvailability(res.d, res.previous, res.d.availabilityStatus, res.active?.tripId ?? null);
    const view = (await this.view(user, [res.d]))[0];
    return res.active
      ? { ...view, warnings: [`Driver still has a planned assignment on trip ${res.activeTrip?.tripNumber ?? res.active.tripId} — reassign it`] }
      : view;
  }

  async reactivate(user: AuthUser, id: string, dto: ReactivateDriverDto, ctx: RequestContext) {
    const res = await this.ds.transaction(async m => {
      const d = await this.lockDriver(m, id);
      if (d.employmentStatus === 'ACTIVE') throw Errors.conflict('Driver is already active');
      const gaps = await this.verificationGaps(m, d);
      if (d.verificationStatus !== 'VERIFIED') gaps.unshift(`Driver verification status is ${d.verificationStatus} (must be VERIFIED)`);
      if (gaps.length) throw Errors.unprocessable('Driver cannot be reactivated — valid verification required', { missingChecks: gaps });
      const before = { employmentStatus: d.employmentStatus, availabilityStatus: d.availabilityStatus, suspensionReason: d.suspensionReason };
      const active = await m.getRepository(DriverTripAssignment).findOne({ where: { driverId: id, status: 'ACTIVE' } });
      d.employmentStatus = 'ACTIVE';
      d.suspensionReason = null;
      if (!active && !['ASSIGNED', 'ON_TRIP'].includes(d.availabilityStatus)) d.availabilityStatus = 'AVAILABLE';
      await m.getRepository(Driver).save(d);
      await this.audit.record(user, 'DRIVER_REACTIVATED', d.id, {
        old: before, new: { employmentStatus: d.employmentStatus, availabilityStatus: d.availabilityStatus }, reason: dto.reason ?? null
      }, ctx, m);
      return { d, previous: before.availabilityStatus, tripId: active?.tripId ?? null };
    });
    if (res.previous !== res.d.availabilityStatus) this.publishAvailability(res.d, res.previous, res.d.availabilityStatus, res.tripId);
    return (await this.view(user, [res.d]))[0];
  }

  // ------------------------------------------------------------------ availability windows

  private windowToFrontend(w: DriverAvailability) {
    return {
      id: w.id, driverId: w.driverId, startAt: iso(w.startAt), endAt: iso(w.endAt), availabilityType: w.availabilityType,
      notes: w.notes, createdBy: w.createdBy, createdAt: iso(w.createdAt)
    };
  }

  async availabilityOverview(user: AuthUser, q: AvailabilityQueryDto) {
    this.assertFleetWide(user);
    const { from, to } = this.parseRange(q);
    const list = await this.drivers.find({ where: { employmentStatus: 'ACTIVE' }, order: { lastName: 'ASC', firstName: 'ASC' } });
    const data = await this.loadEligibilityData(list.map(d => d.id), from, to);
    const views = await this.view(user, list);
    const items = list.map((d, i) => {
      const dd = data.get(d.id)!;
      const reasons = evaluateEligibility(d, dd, { from, to });
      return {
        driver: views[i],
        free: reasons.length === 0,
        status: reasons.length === 0 ? 'FREE' : 'BUSY',
        reasons,
        windows: dd.windows.map(w => this.windowToFrontend(w)),
        activeTripIds: dd.activeAssignments.map(a => a.tripId)
      };
    });
    return { from: from.toISOString(), to: to.toISOString(), total: items.length, free: items.filter(x => x.free).length, items };
  }

  async addAvailability(user: AuthUser, id: string, dto: CreateAvailabilityDto, ctx: RequestContext) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) throw Errors.unprocessable('endAt must be after startAt', { field: 'endAt' });
    const res = await this.ds.transaction(async m => {
      const d = await this.lockDriver(m, id);
      const repo = m.getRepository(DriverAvailability);
      const w = await repo.save(repo.create({
        driverId: d.id, startAt, endAt, availabilityType: dto.availabilityType, notes: dto.notes ?? null, createdBy: user.name
      }));
      await this.audit.record(user, 'DRIVER_AVAILABILITY_ADDED', d.id, { old: null, new: this.windowToFrontend(w) }, ctx, m);
      const active = await m.getRepository(DriverTripAssignment).findOne({ where: { driverId: id, status: 'ACTIVE' } });
      return { w, active };
    });
    const warnings: string[] = [];
    if (res.active && ['LEAVE', 'UNAVAILABLE', 'TRAINING'].includes(dto.availabilityType)) {
      const t = await this.trips.findOne({ where: { id: res.active.tripId } });
      const tEnd = t?.estimatedArrivalAt ?? t?.plannedStartAt ?? null;
      if (t && (!tEnd || startAt <= tEnd)) warnings.push(`Driver has an active assignment on trip ${t.tripNumber} that may overlap this window`);
    }
    return { ...this.windowToFrontend(res.w), warnings };
  }

  async removeAvailability(user: AuthUser, id: string, availabilityId: string, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const repo = m.getRepository(DriverAvailability);
      const w = await repo.findOne({ where: { id: availabilityId, driverId: id } });
      if (!w) throw Errors.notFound('Availability window');
      await repo.delete({ id: w.id });
      await this.audit.record(user, 'DRIVER_AVAILABILITY_REMOVED', id, { old: this.windowToFrontend(w), new: null }, ctx, m);
    });
    return { id: availabilityId, deleted: true };
  }

  // ------------------------------------------------------------------ eligibility / expiry

  async eligible(user: AuthUser, q: EligibleQueryDto) {
    this.assertFleetWide(user);
    const { from, to } = this.parseRange(q);
    let vehicleType: VehicleType | null | undefined;
    if (q.vehicleTypeId) {
      vehicleType = await this.vehicleTypes.findOne({ where: { id: q.vehicleTypeId } });
      if (!vehicleType) throw Errors.notFound('Vehicle type');
    }
    const list = await this.drivers.find({ where: { employmentStatus: Not('INACTIVE') }, order: { lastName: 'ASC', firstName: 'ASC' } });
    const data = await this.loadEligibilityData(list.map(d => d.id), from, to);
    const views = await this.view(user, list);
    const eligible: any[] = [];
    const ineligible: Array<{ driver: any; reasons: string[] }> = [];
    list.forEach((d, i) => {
      const reasons = evaluateEligibility(d, { ...data.get(d.id)!, vehicleType }, { from, to, excludeTripId: q.excludeTripId });
      if (reasons.length) ineligible.push({ driver: views[i], reasons });
      else eligible.push(views[i]);
    });
    return {
      from: from.toISOString(), to: to.toISOString(),
      vehicleType: vehicleType ? { id: vehicleType.id, code: vehicleType.code, name: vehicleType.name, allowedLicenceClasses: vehicleType.allowedLicenceClasses } : null,
      eligible, ineligible
    };
  }

  async expiring(user: AuthUser, days?: number) {
    this.assertFleetWide(user);
    const window = days ?? (await this.warningDays());
    const today = ymd();
    const horizon = addDaysYmd(today, window);
    const list = await this.drivers.find({ where: { employmentStatus: Not('INACTIVE') } });
    const byId = new Map(list.map(d => [d.id, d]));
    const ref = (d: Driver) => ({ driverId: d.id, employeeNumber: d.employeeNumber, name: `${d.firstName} ${d.lastName}`.trim(), availabilityStatus: d.availabilityStatus });
    const entry = (expiresAt: string) => ({ expiresAt, daysRemaining: daysBetween(today, expiresAt), expired: expiresAt < today });

    const licences = list.filter(d => d.licenceExpiryDate && d.licenceExpiryDate <= horizon)
      .map(d => ({ ...ref(d), licenceClass: d.licenceClass, ...entry(d.licenceExpiryDate) }));
    const certifications = list.flatMap(d => (d.certifications || [])
      .filter(c => c?.expiresAt && c.expiresAt <= horizon)
      .map(c => ({ ...ref(d), certification: c.name, ...entry(c.expiresAt as string) })));
    const docs = list.length
      ? await this.documents.find({ where: { driverId: In(list.map(d => d.id)), expiresAt: LessThanOrEqual(horizon), verificationStatus: Not('REJECTED') } })
      : [];
    const documents = docs.filter(x => byId.has(x.driverId)).map(x => ({
      ...ref(byId.get(x.driverId)!), documentId: x.id, documentType: x.documentType, verificationStatus: x.verificationStatus, ...entry(x.expiresAt as string)
    }));
    const sort = <T extends { expiresAt: string }>(a: T[]) => a.sort((x, y) => x.expiresAt.localeCompare(y.expiresAt));
    return {
      days: window, asOf: today, horizon,
      total: licences.length + certifications.length + documents.length,
      licences: sort(licences), certifications: sort(certifications), documents: sort(documents)
    };
  }

  // ------------------------------------------------------------------ history / KPIs / audit

  private tripSummary(t: Trip) {
    return {
      id: t.id, tripNumber: t.tripNumber, status: t.status, truckId: t.truckId, routeId: t.routeId,
      plannedStartAt: iso(t.plannedStartAt), actualStartAt: iso(t.actualStartAt), estimatedArrivalAt: iso(t.estimatedArrivalAt),
      actualArrivalAt: iso(t.actualArrivalAt), completedAt: iso(t.completedAt)
    };
  }

  private assignmentToFrontend(a: DriverTripAssignment, trip: any) {
    return {
      assignmentId: a.id, role: a.role, assignmentStatus: a.status, assignedAt: iso(a.assignedAt), releasedAt: iso(a.releasedAt),
      assignedBy: a.assignedBy, trip
    };
  }

  async tripHistory(user: AuthUser, id: string, q: PageQueryDto): Promise<Paged<any>> {
    await this.readable(user, id);
    const { page, pageSize, skip, take } = pageParams(q);
    const [rows, total] = await this.assignments.findAndCount({ where: { driverId: id }, order: { assignedAt: 'DESC' }, skip, take });
    const tripIds = [...new Set(rows.map(a => a.tripId))];
    const trips = tripIds.length ? await this.trips.find({ where: { id: In(tripIds) } }) : [];
    const items = rows.map(a => {
      const t = trips.find(x => x.id === a.tripId);
      return this.assignmentToFrontend(a, t ? this.tripSummary(t) : { id: a.tripId });
    });
    return { items, total, page, pageSize };
  }

  async performance(user: AuthUser, id: string, q: PerformanceQueryDto) {
    const d = await this.readable(user, id);
    const thresholds = await logisticsThresholds(this.settings);
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;

    const assigned = await this.assignments.find({ where: { driverId: id } });
    const primary = await this.trips.find({ where: { primaryDriverId: id } });
    const extraIds = [...new Set(assigned.map(a => a.tripId))].filter(tid => !primary.some(t => t.id === tid));
    const all = [...primary, ...(extraIds.length ? await this.trips.find({ where: { id: In(extraIds) } }) : [])];
    const ended = (t: Trip) => t.completedAt ?? t.actualArrivalAt ?? t.updatedAt;
    const inRange = (t: Trip) => {
      const at = ended(t) ?? t.plannedStartAt;
      return (!from || at >= from) && (!to || at <= to);
    };
    const trips = all.filter(inRange);
    const completed = trips.filter(t => t.status === 'COMPLETED');
    const aborted = trips.filter(t => t.status === 'ABORTED');

    // on-time: arrival vs latest planned delivery of the trip's shipments (+ tolerance)
    const completedIds = completed.map(t => t.id);
    const links = completedIds.length ? await this.tripShipments.find({ where: { tripId: In(completedIds) } }) : [];
    const shipmentIds = [...new Set(links.map(l => l.shipmentId))];
    const shipments = shipmentIds.length ? await this.shipments.find({ where: { id: In(shipmentIds) } }) : [];
    const toleranceMs = thresholds.delayToleranceMinutes * 60_000;
    let evaluated = 0;
    let onTime = 0;
    for (const t of completed) {
      const planned = links.filter(l => l.tripId === t.id)
        .map(l => shipments.find(s => s.id === l.shipmentId)?.plannedDeliveryAt)
        .filter((x): x is Date => !!x)
        .map(x => new Date(x).getTime());
      const arrival = t.actualArrivalAt ?? t.completedAt;
      if (!planned.length || !arrival) continue;
      evaluated++;
      if (new Date(arrival).getTime() <= Math.max(...planned) + toleranceMs) onTime++;
    }

    const tripIds = trips.map(t => t.id);
    const [deliveries, incidents] = tripIds.length
      ? await Promise.all([
        this.deliveries.find({ where: { tripId: In(tripIds) } }),
        this.tripEvents.find({ where: { tripId: In(tripIds), type: 'INCIDENT' }, order: { occurredAt: 'DESC' } })
      ])
      : [[], []] as [Delivery[], TripEvent[]];
    const discrepancies = deliveries.filter(x => Number(x.discrepancyQuantity) !== 0);
    const bySeverity: Record<string, number> = {};
    for (const e of incidents) bySeverity[e.severity || 'UNSPECIFIED'] = (bySeverity[e.severity || 'UNSPECIFIED'] || 0) + 1;

    return {
      driverId: d.id,
      employeeNumber: d.employeeNumber,
      name: `${d.firstName} ${d.lastName}`.trim(),
      period: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      totalTrips: trips.length,
      completedTrips: completed.length,
      abortedTrips: aborted.length,
      onTime: {
        evaluatedTrips: evaluated,
        onTimeTrips: onTime,
        lateTrips: evaluated - onTime,
        onTimeRatePct: evaluated ? Math.round((onTime / evaluated) * 1000) / 10 : null,
        toleranceMinutes: thresholds.delayToleranceMinutes,
        basis: 'trip actualArrivalAt vs latest shipment plannedDeliveryAt + tolerance'
      },
      deliveryDiscrepancies: {
        deliveries: deliveries.length,
        withDiscrepancy: discrepancies.length,
        totalDiscrepancyQuantity: Math.round(discrepancies.reduce((s, x) => s + Math.abs(Number(x.discrepancyQuantity) || 0), 0) * 100) / 100
      },
      incidents: {
        total: incidents.length,
        bySeverity,
        recent: incidents.slice(0, 10).map(e => ({ id: e.id, tripId: e.tripId, severity: e.severity, description: e.description, occurredAt: iso(e.occurredAt) }))
      },
      reviewNote: 'Indicators for supervisor review only — not for automated disciplinary decisions (raw GPS excluded)'
    };
  }

  async auditHistory(user: AuthUser, id: string, q: PageQueryDto): Promise<Paged<any>> {
    this.assertFleetWide(user);
    if (!(await this.drivers.exist({ where: { id } }))) throw Errors.notFound('Driver');
    const { page, pageSize, skip, take } = pageParams(q);
    const all = await this.audit.list({ target: id, limit: 5000 });
    return { items: all.slice(skip, skip + take), total: all.length, page, pageSize };
  }
}

