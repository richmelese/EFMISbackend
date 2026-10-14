import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, In } from 'typeorm';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { AlertSeverity } from '../../../common/constants/rules';
import { AlertsService } from '../../alerts/alerts.service';
import { AuditService } from '../../audit/audit.service';
import { Paged, pageParams } from '../logistics.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { InventoryService } from '../warehouses/inventory.service';
import { InventoryAllocation, InventoryLot } from '../warehouses/entities/warehouse.entities';
import { CreateIncidentDto, CreateScanDto, ListIncidentsQueryDto, ResolveIncidentDto, UpdateIncidentDto } from './dto/custody.dto';
import { SecurityIncident, ShipmentScanEvent } from './entities/custody.entities';
import { Shipment, Trip, TripShipment } from './entities/shipment.entities';
import { ShipmentsService } from './shipments.service';
import { isFleetWide } from './shipments.util';

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
const INCIDENT_LOCK = 734_221;
const THEFT_LIKE = ['THEFT', 'DIVERSION', 'ROBBERY', 'TAMPERING'];
const SEVERITY_TO_ALERT: Record<string, AlertSeverity> = { CRITICAL: 'CRITICAL_RED', HIGH: 'HIGH_ORANGE', MEDIUM: 'MEDIUM_YELLOW', LOW: 'LOW_BLUE' };
/** Shipment statuses in which each custody point makes sense */
const SCAN_WINDOW: Record<string, string[]> = {
  DISPATCH_ORIGIN: ['ASSIGNED', 'READY_FOR_DISPATCH', 'IN_TRANSIT'],
  CHECKPOINT: ['IN_TRANSIT'],
  HANDOVER: ['IN_TRANSIT', 'ARRIVED'],
  RECEIVE_DESTINATION: ['IN_TRANSIT', 'ARRIVED', 'DELIVERED']
};

/**
 * Chain of custody (QR scans at origin, checkpoints, handover, destination) and security incidents (theft, diversion,
 * robbery, tampering, accident, unauthorised stop) with police references and resolution.
 */
@Injectable()
export class CustodyService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly shipments: ShipmentsService,
    private readonly inventory: InventoryService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService
  ) {}

  private async visibleShipment(user: AuthUser, id: string): Promise<Shipment> {
    const s = await this.ds.getRepository(Shipment).findOneBy({ id });
    if (!s) throw Errors.notFound('Shipment');
    await this.shipments.assertVisible(user, s);
    return s;
  }

  private async activeTripId(shipmentId: string): Promise<string | null> {
    const row = await this.ds.getRepository(TripShipment).createQueryBuilder('ts').innerJoin(Trip, 't', 't.id = ts.tripId')
      .select('t.id', 'id').where('ts.shipmentId = :sid', { sid: shipmentId }).orderBy('t.createdAt', 'DESC').getRawOne<{ id: string }>();
    return row?.id ?? null;
  }

  /** Lot numbers that legitimately belong to the shipment: reserved/loaded lots, plus its declared QR lot. */
  private async expectedLots(s: Shipment): Promise<Set<string>> {
    const allocs = await this.ds.getRepository(InventoryAllocation).find({ where: { referenceType: 'SHIPMENT', referenceId: s.id } });
    const lots = allocs.length ? await this.ds.getRepository(InventoryLot).findBy({ id: In(allocs.map(a => a.lotId)) }) : [];
    const set = new Set(lots.map(l => l.lotNumber.toUpperCase()));
    if (s.qrLot) set.add(s.qrLot.trim().toUpperCase());
    return set;
  }

  // ------------------------------------------------------------------ scans

  scanToFrontend(e: ShipmentScanEvent) {
    return {
      id: e.id, shipmentId: e.shipmentId, tripId: e.tripId, scanType: e.scanType, lotNumber: e.lotNumber, bagCount: e.bagCount, result: e.result,
      scannedBy: e.scannedBy, scannedByName: e.scannedByName, deviceSerial: e.deviceSerial, warehouseId: e.warehouseId,
      lat: e.latitude, lng: e.longitude, locationLabel: e.locationLabel, notes: e.notes, clientScanId: e.clientScanId,
      scannedAt: iso(e.scannedAt), receivedAt: iso(e.receivedAt)
    };
  }

  async recordScan(user: AuthUser, shipmentId: string, dto: CreateScanDto, ctx: RequestContext) {
    const s = await this.visibleShipment(user, shipmentId);
    const repo = this.ds.getRepository(ShipmentScanEvent);
    if (dto.clientScanId) {
      const prev = await repo.findOneBy({ clientScanId: dto.clientScanId });
      if (prev) {
        if (prev.shipmentId !== s.id) throw Errors.conflict('clientScanId was already used for another shipment');
        return { ...this.scanToFrontend(prev), replayed: true };
      }
    }
    if (!SCAN_WINDOW[dto.scanType].includes(s.status)) {
      throw Errors.conflict(`A ${dto.scanType.replace(/_/g, ' ').toLowerCase()} scan is not valid while the shipment is ${s.status}`, { allowed: SCAN_WINDOW[dto.scanType] });
    }
    // Warehouse operators scan at their own warehouse only (dispatch at the origin, receipt at the destination).
    const warehouseId = dto.scanType === 'DISPATCH_ORIGIN' ? s.originWarehouseId : dto.scanType === 'RECEIVE_DESTINATION' ? s.destinationWarehouseId : null;
    if (user.role === 'WAREHOUSE_OPERATOR' && warehouseId && user.warehouseId !== warehouseId) {
      throw Errors.forbidden('Scan at your own warehouse only');
    }
    const scannedAt = dto.scannedAt ? new Date(dto.scannedAt) : new Date();
    if (scannedAt.getTime() > Date.now() + 5 * 60_000) throw Errors.unprocessable('scannedAt is in the future');
    const lotNumber = dto.lotNumber.trim().toUpperCase();
    const expected = await this.expectedLots(s);
    const result = expected.size === 0 ? 'UNVERIFIED' : expected.has(lotNumber) ? 'MATCH' : 'MISMATCH';
    const tripId = await this.activeTripId(s.id);
    const saved = await repo.save(repo.create({
      shipmentId: s.id, tripId, scanType: dto.scanType, lotNumber, bagCount: dto.bagCount ?? null, result,
      scannedBy: user.id, scannedByName: user.name, deviceSerial: dto.deviceSerial ?? null, warehouseId,
      latitude: dto.lat ?? null, longitude: dto.lng ?? null, locationLabel: dto.locationLabel ?? null, notes: dto.notes ?? null,
      clientScanId: dto.clientScanId ?? null, scannedAt
    }));
    await this.audit.record(user, 'SHIPMENT_SCAN', s.id, { scanType: dto.scanType, lotNumber, result, bagCount: dto.bagCount ?? null }, ctx);
    if (result === 'MISMATCH') {
      const alert = await this.alerts.raise({
        severity: 'CRITICAL_RED', category: 'Theft/Diversion Risk',
        title: `QR lot mismatch on ${s.shipmentNumber}: scanned ${lotNumber}`,
        trigger: `${dto.scanType.replace(/_/g, ' ')} scan by ${user.name}${dto.locationLabel ? ` at ${dto.locationLabel}` : ''}: ${lotNumber} is not one of ${[...expected].join(', ')}`,
        affectedArea: dto.locationLabel ?? null, actionRequired: 'Stop and inspect the cargo; verify seals and bag QR codes against the waybill.',
        sourceType: 'SHIPMENT', sourceId: s.id, dedupeKey: `SCAN-MISMATCH-${s.id}-${lotNumber}`
      });
      this.realtime.publish('alert.created', { alertId: alert.id, shipmentIds: [s.id], tripId, warehouseIds: [s.originWarehouseId, s.destinationWarehouseId] }, alert);
    }
    return this.scanToFrontend(saved);
  }

  /** Custody chain of a shipment with a summary (scanned out, checkpoints, received, mismatches). */
  async listScans(user: AuthUser, shipmentId: string) {
    const s = await this.visibleShipment(user, shipmentId);
    const rows = await this.ds.getRepository(ShipmentScanEvent).find({ where: { shipmentId: s.id }, order: { scannedAt: 'ASC' } });
    const items = rows.map(r => this.scanToFrontend(r));
    const bags = (type: string) => rows.filter(r => r.scanType === type && r.bagCount !== null).reduce((n, r) => n + (r.bagCount ?? 0), 0);
    return {
      shipmentId: s.id, shipmentNumber: s.shipmentNumber, expectedLots: [...(await this.expectedLots(s))],
      summary: {
        dispatchScanned: rows.some(r => r.scanType === 'DISPATCH_ORIGIN'), checkpoints: rows.filter(r => r.scanType === 'CHECKPOINT').length,
        handovers: rows.filter(r => r.scanType === 'HANDOVER').length, received: rows.some(r => r.scanType === 'RECEIVE_DESTINATION'),
        mismatches: rows.filter(r => r.result === 'MISMATCH').length,
        bagsOut: bags('DISPATCH_ORIGIN'), bagsIn: bags('RECEIVE_DESTINATION')
      },
      items
    };
  }

  // ------------------------------------------------------------------ incidents

  async incidentToFrontend(i: SecurityIncident) {
    const s = i.shipmentId ? await this.ds.getRepository(Shipment).findOne({ where: { id: i.shipmentId }, select: { id: true, shipmentNumber: true } }) : null;
    const t = i.tripId ? await this.ds.getRepository(Trip).findOne({ where: { id: i.tripId }, select: { id: true, tripNumber: true } }) : null;
    return {
      id: i.id, incidentNumber: i.incidentNumber, incidentType: i.incidentType, severity: i.severity, status: i.status, description: i.description,
      occurredAt: iso(i.occurredAt), lat: i.latitude, lng: i.longitude, locationLabel: i.locationLabel, quantityAffectedMt: i.quantityAffectedMt,
      policeReportNo: i.policeReportNo, policeStation: i.policeStation, resolution: i.resolution, resolvedBy: i.resolvedBy, resolvedAt: iso(i.resolvedAt),
      shipmentId: i.shipmentId, shipmentNumber: s?.shipmentNumber ?? null, tripId: i.tripId, tripNumber: t?.tripNumber ?? null, truckId: i.truckId,
      reportedBy: i.reportedBy, reportedByName: i.reportedByName, alertId: i.alertId, createdAt: iso(i.createdAt), updatedAt: iso(i.updatedAt)
    };
  }

  private async assertIncidentVisible(user: AuthUser, i: SecurityIncident) {
    if (isFleetWide(user) || i.reportedBy === user.id) return;
    if (i.shipmentId) {
      const s = await this.ds.getRepository(Shipment).findOneBy({ id: i.shipmentId });
      if (s) { await this.shipments.assertVisible(user, s); return; }
    }
    throw Errors.forbidden('This incident is outside your logistics scope');
  }

  async listIncidents(user: AuthUser, q: ListIncidentsQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.ds.getRepository(SecurityIncident).createQueryBuilder('i');
    if (q.status) qb.andWhere('i.status IN (:...st)', { st: q.status.split(',').map(x => x.trim().toUpperCase()) });
    if (q.incidentType) qb.andWhere('i.incidentType = :ty', { ty: q.incidentType });
    if (q.severity) qb.andWhere('i.severity IN (:...sev)', { sev: q.severity.split(',').map(x => x.trim().toUpperCase()) });
    if (q.shipmentId) qb.andWhere('i.shipmentId = :sid', { sid: q.shipmentId });
    if (q.tripId) qb.andWhere('i.tripId = :tid', { tid: q.tripId });
    if (q.from) qb.andWhere('i.occurredAt >= :from', { from: new Date(q.from) });
    if (q.to) qb.andWhere('i.occurredAt <= :to', { to: new Date(q.to) });
    if (!isFleetWide(user)) {
      const scope = await this.shipments.scopeFor(user);
      const sub = this.ds.getRepository(Shipment).createQueryBuilder('s').select('s.id');
      this.shipments.applyScope(sub, 's', scope);
      qb.andWhere(new Brackets(b => b.where('i.reportedBy = :me', { me: user.id }).orWhere(`i.shipmentId IN (${sub.getQuery()})`)));
      qb.setParameters(sub.getParameters());
    }
    const [rows, total] = await qb.orderBy('i.occurredAt', 'DESC').skip(skip).take(take).getManyAndCount();
    return { items: await Promise.all(rows.map(r => this.incidentToFrontend(r))), total, page, pageSize };
  }

  async getIncident(user: AuthUser, id: string) {
    const i = await this.ds.getRepository(SecurityIncident).findOneBy({ id });
    if (!i) throw Errors.notFound('Security incident');
    await this.assertIncidentVisible(user, i);
    return this.incidentToFrontend(i);
  }

  async reportIncident(user: AuthUser, dto: CreateIncidentDto, ctx: RequestContext) {
    let shipment: Shipment | null = null;
    let trip: Trip | null = null;
    if (dto.shipmentId) shipment = await this.visibleShipment(user, dto.shipmentId);
    if (dto.tripId) {
      trip = await this.ds.getRepository(Trip).findOneBy({ id: dto.tripId });
      if (!trip) throw Errors.notFound('Trip');
    } else if (shipment) {
      const tid = await this.activeTripId(shipment.id);
      trip = tid ? await this.ds.getRepository(Trip).findOneBy({ id: tid }) : null;
    }
    if (trip && !shipment) {
      const link = await this.ds.getRepository(TripShipment).findOne({ where: { tripId: trip.id }, order: { stopSequence: 'ASC' } });
      shipment = link ? await this.ds.getRepository(Shipment).findOneBy({ id: link.shipmentId }) : null;
      if (shipment) await this.shipments.assertVisible(user, shipment);
    }
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw Errors.unprocessable('occurredAt is in the future');
    const severity = dto.severity ?? (THEFT_LIKE.includes(dto.incidentType) ? 'CRITICAL' : dto.incidentType === 'ACCIDENT' ? 'HIGH' : 'MEDIUM');
    const saved = await this.ds.transaction(async m => {
      await m.query('SELECT pg_advisory_xact_lock($1)', [INCIDENT_LOCK]);
      const [row] = await m.query(`SELECT COALESCE(MAX(CAST(SUBSTRING(incident_number FROM 4) AS INTEGER)), 1000) AS n FROM security_incidents WHERE incident_number ~ '^SI-[0-9]+$'`);
      const incidentNumber = `SI-${Number(row?.n ?? 1000) + 1}`;
      const repo = m.getRepository(SecurityIncident);
      const inc = await repo.save(repo.create({
        incidentNumber, shipmentId: shipment?.id ?? null, tripId: trip?.id ?? null, truckId: trip?.truckId ?? null,
        incidentType: dto.incidentType, severity, description: dto.description.trim(), occurredAt,
        latitude: dto.lat ?? null, longitude: dto.lng ?? null, locationLabel: dto.locationLabel ?? null, quantityAffectedMt: dto.quantityAffectedMt ?? null,
        policeReportNo: dto.policeReportNo ?? null, policeStation: dto.policeStation ?? null, status: 'OPEN',
        reportedBy: user.id, reportedByName: user.name
      }));
      const alert = await this.alerts.raise({
        severity: SEVERITY_TO_ALERT[severity], category: THEFT_LIKE.includes(dto.incidentType) ? 'Theft/Diversion Risk' : 'Logistics',
        title: `${incidentNumber}: ${dto.incidentType.replace(/_/g, ' ').toLowerCase()}${shipment ? ` — ${shipment.shipmentNumber}` : ''}`,
        trigger: dto.description.slice(0, 500), affectedArea: dto.locationLabel ?? null,
        actionRequired: THEFT_LIKE.includes(dto.incidentType) ? 'Contact the driver and the nearest police station; secure the cargo; record the police report number.' : 'Assess and decide whether the trip can continue.',
        sourceType: shipment ? 'SHIPMENT' : trip ? 'TRIP' : null, sourceId: shipment?.id ?? trip?.id ?? null, dedupeKey: `SECURITY-${inc.id}`
      }, m);
      await repo.update({ id: inc.id }, { alertId: alert.id });
      inc.alertId = alert.id;
      await this.audit.record(user, 'SECURITY_INCIDENT_REPORTED', inc.id, { incidentNumber, incidentType: dto.incidentType, severity, shipmentId: inc.shipmentId, tripId: inc.tripId }, ctx, m);
      return { inc, alert };
    });
    this.realtime.publish('alert.created', {
      alertId: saved.alert.id, tripId: trip?.id ?? null, truckId: trip?.truckId ?? null, driverId: trip?.primaryDriverId ?? null,
      shipmentIds: shipment ? [shipment.id] : [], warehouseIds: shipment ? [shipment.originWarehouseId, shipment.destinationWarehouseId] : []
    }, saved.alert);
    return this.incidentToFrontend(saved.inc);
  }

  async updateIncident(user: AuthUser, id: string, dto: UpdateIncidentDto, ctx: RequestContext) {
    const repo = this.ds.getRepository(SecurityIncident);
    const i = await repo.findOneBy({ id });
    if (!i) throw Errors.notFound('Security incident');
    if (i.status === 'RESOLVED' || i.status === 'CLOSED') throw Errors.conflict(`Incident ${i.incidentNumber} is ${i.status}`);
    const before = await this.incidentToFrontend(i);
    const patch: Partial<SecurityIncident> = {};
    for (const k of ['severity', 'status', 'description', 'quantityAffectedMt', 'policeReportNo', 'policeStation', 'locationLabel'] as const) {
      if (dto[k] !== undefined) (patch as any)[k] = dto[k];
    }
    await repo.update({ id }, patch);
    const after = await this.incidentToFrontend((await repo.findOneByOrFail({ id })));
    await this.audit.record(user, 'SECURITY_INCIDENT_UPDATED', id, { old: Object.fromEntries(Object.keys(patch).map(k => [k, (before as any)[k]])), new: patch }, ctx);
    return after;
  }

  async resolveIncident(user: AuthUser, id: string, dto: ResolveIncidentDto, ctx: RequestContext) {
    const repo = this.ds.getRepository(SecurityIncident);
    const i = await repo.findOneBy({ id });
    if (!i) throw Errors.notFound('Security incident');
    if (i.status === 'RESOLVED' || i.status === 'CLOSED') throw Errors.conflict(`Incident ${i.incidentNumber} is already ${i.status}`);
    const policeReportNo = dto.policeReportNo ?? i.policeReportNo;
    if (THEFT_LIKE.includes(i.incidentType) && !policeReportNo) throw Errors.unprocessable(`A police report number is required to resolve a ${i.incidentType.toLowerCase()} incident`, { field: 'policeReportNo' });
    await repo.update({ id }, { status: 'RESOLVED', resolution: dto.resolution.trim(), policeReportNo, resolvedBy: user.name, resolvedAt: new Date() });
    await this.audit.record(user, 'SECURITY_INCIDENT_RESOLVED', id, { resolution: dto.resolution, policeReportNo }, ctx);
    return this.incidentToFrontend(await repo.findOneByOrFail({ id }));
  }

  async closeIncident(user: AuthUser, id: string, ctx: RequestContext) {
    const repo = this.ds.getRepository(SecurityIncident);
    const i = await repo.findOneBy({ id });
    if (!i) throw Errors.notFound('Security incident');
    if (i.status !== 'RESOLVED') throw Errors.conflict('Only a resolved incident can be closed');
    await repo.update({ id }, { status: 'CLOSED' });
    await this.audit.record(user, 'SECURITY_INCIDENT_CLOSED', id, null, ctx);
    return this.incidentToFrontend(await repo.findOneByOrFail({ id }));
  }
}

