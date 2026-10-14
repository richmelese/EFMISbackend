import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { RULES } from '../../../common/constants/rules';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { sha256 } from '../../../common/utils/helpers';
import { AlertsService } from '../../alerts/alerts.service';
import { AuditService } from '../../audit/audit.service';
import { RealtimeService } from '../realtime/realtime.service';
import { InventoryService } from '../warehouses/inventory.service';
import { ConfirmDeliveryDto } from './dto/shipment.dto';
import { Delivery, Shipment, Trip, TripEvent, TripShipment } from './entities/shipment.entities';
import { ShipmentChange, ShipmentsService, deliveryToFrontend } from './shipments.service';
import { PROOF_MIME_EXT, QTY_EPS, UploadedProof, iso, isWarehouseOperator, r3, uniqueViolation } from './shipments.util';

const PROOF_AREA = 'proof-of-delivery';
const DAMAGE_CONDITIONS = ['DAMAGED', 'PARTIAL_DAMAGE', 'WET'];

/**
 * Delivery confirmation = handover evidence (Logistics doc §9.3, §10 steps 39–41, §13 partial / damaged / short deliveries).
 * Idempotent through the Idempotency-Key header; proof of delivery stored in private storage and served only via an audited endpoint.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeService,
    private readonly shipments: ShipmentsService,
    private readonly inventory: InventoryService
  ) {}

  private storageRoot(): string {
    return path.resolve(this.config.get<string>('logistics.proofStorageDir') || path.resolve(process.cwd(), 'storage/private'));
  }

  private assertDestinationOperator(user: AuthUser, s: Shipment) {
    if (isWarehouseOperator(user) && (!user.warehouseId || user.warehouseId !== s.destinationWarehouseId)) {
      throw Errors.forbidden('Only the destination warehouse operator can confirm or view this delivery');
    }
  }

  private async replay(existing: Delivery, shipmentId: string) {
    if (existing.shipmentId !== shipmentId) throw Errors.conflict('Idempotency-Key was already used for a different shipment');
    const s = await this.shipments.getRow(existing.shipmentId);
    return { replayed: true, delivery: deliveryToFrontend(existing), shipment: await this.shipments.shipmentToFrontend(s) };
  }

  async list(user: AuthUser, shipmentId: string) {
    const s = await this.shipments.getVisible(user, shipmentId);
    const rows = await this.ds.getRepository(Delivery).find({ where: { shipmentId: s.id }, order: { deliveredAt: 'ASC' } });
    return rows.map(d => deliveryToFrontend(d));
  }

  async confirm(user: AuthUser, shipmentId: string, dto: ConfirmDeliveryDto, file: UploadedProof | undefined, idempotencyKey: string | undefined, ctx: RequestContext) {
    const key = idempotencyKey?.trim() || null;
    if (key && key.length > 80) throw Errors.unprocessable('Idempotency-Key must be at most 80 characters');
    if (key) {
      const existing = await this.ds.getRepository(Delivery).findOne({ where: { idempotencyKey: key } });
      if (existing) return this.replay(existing, shipmentId);
    }
    const received = r3(dto.receivedQuantity);
    if (!(received >= 0)) throw Errors.unprocessable('receivedQuantity must be ≥ 0');

    // ---- proof file (validated + written before the transaction; removed again on failure)
    let storageKey: string | null = null;
    let proofHash: string | null = null;
    let absPath: string | null = null;
    if (file) {
      if (!RULES.uploadMimeTypes.includes(file.mimetype)) throw Errors.unprocessable('Proof of delivery must be a JPEG, PNG or PDF file');
      const max = this.config.get<number>('maxUploadBytes') ?? 5 * 1024 * 1024;
      if (file.size > max) throw Errors.unprocessable(`Proof of delivery exceeds the maximum size of ${Math.round(max / 1024 / 1024)} MB`);
      proofHash = sha256(file.buffer.toString('base64'));
      const dup = await this.ds.getRepository(Delivery).findOne({ where: { proofSha256: proofHash }, select: ['id', 'shipmentId'] });
      if (dup) throw Errors.conflict('Duplicate proof of delivery (identical file already attached to another delivery)', { deliveryId: dup.id, shipmentId: dup.shipmentId });
      const name = randomUUID() + PROOF_MIME_EXT[file.mimetype];
      storageKey = `${PROOF_AREA}/${name}`;
      const dir = path.join(this.storageRoot(), PROOF_AREA);
      await fs.promises.mkdir(dir, { recursive: true });
      absPath = path.join(dir, name);
      await fs.promises.writeFile(absPath, file.buffer, { mode: 0o600 });
    }

    let change: ShipmentChange | null = null;
    let alert: any = null;
    let trip: Trip | null = null;
    let delivery: Delivery;
    try {
      delivery = await this.ds.transaction(async m => {
        const s = await this.shipments.getRow(shipmentId, m, true);
        this.assertDestinationOperator(user, s);
        await this.shipments.assertVisible(user, s);

        const link = await m.getRepository(TripShipment).createQueryBuilder('ts').innerJoin(Trip, 't', 't.id = ts.tripId')
          .where('ts.shipmentId = :sid', { sid: s.id }).andWhere(`t.status <> 'ABORTED'`).orderBy('t.createdAt', 'DESC').getOne();
        if (!link) throw Errors.conflict(`Shipment ${s.shipmentNumber} is not on a trip`);
        trip = await m.getRepository(Trip).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: link.tripId }).getOne();
        if (!trip) throw Errors.conflict(`Shipment ${s.shipmentNumber} is not on a trip`);

        const fromStatus = s.status;
        if (s.status === 'IN_TRANSIT' && ['ARRIVED', 'UNLOADING'].includes(trip.status)) {
          change = await this.shipments.setStatus(m, user, s, 'ARRIVED', 'SHIPMENT_ARRIVED', ctx, {}, { tripId: trip.id });
        } else if (s.status !== 'ARRIVED') {
          throw Errors.conflict(`Delivery can only be confirmed for an ARRIVED shipment (is ${s.status}, trip ${trip.status})`);
        }

        const loaded = s.loadedQuantity ?? link.loadedQuantity;
        if (loaded === null || loaded === undefined) throw Errors.conflict(`Shipment ${s.shipmentNumber} has no loaded quantity recorded`);
        const prevRow = await m.getRepository(Delivery).createQueryBuilder('d').select('COALESCE(SUM(d.receivedQuantity), 0)', 'sum')
          .where('d.shipmentId = :sid AND d.status <> :rej', { sid: s.id, rej: 'REJECTED' }).getRawOne();
        const previous = r3(prevRow?.sum);
        const cumulative = r3(previous + received);
        const discrepancy = r3(cumulative - loaded);
        const hasDiscrepancy = Math.abs(discrepancy) > QTY_EPS;
        const isFinal = cumulative >= loaded - QTY_EPS || dto.finalDelivery === true;
        const flagged = hasDiscrepancy || dto.condition !== 'GOOD';
        if (flagged && !storageKey) {
          throw Errors.unprocessable('Proof of delivery (field "proof": JPEG, PNG or PDF) is required when there is a discrepancy or the cargo is not in GOOD condition', {
            loadedQuantity: loaded, cumulativeReceived: cumulative, discrepancy, condition: dto.condition
          });
        }

        const repo = m.getRepository(Delivery);
        const d = await repo.save(repo.create({
          shipmentId: s.id, tripId: trip.id, deliveredAt: new Date(), receiverName: dto.receiverName, receiverPhone: dto.receiverPhone ?? null,
          receivedQuantity: received, quantityUnit: 'MT', discrepancyQuantity: discrepancy, condition: dto.condition, notes: dto.notes ?? null,
          proofOfDeliveryStorageKey: storageKey, proofSha256: proofHash, proofMimeType: file?.mimetype ?? null, confirmedBy: user.name,
          status: flagged ? 'DISCREPANCY' : 'CONFIRMED', idempotencyKey: key
        }));

        // stock: receipt at destination; ledger note for the final shortage (loss / damage in transit)
        if (s.productId && received > 0) {
          // same lot numbers as loaded at the origin (traceability), linked to their source lots
          await this.inventory.receive(s.destinationWarehouseId, s.productId, received, 'DELIVERY_RECEIPT', { type: 'DELIVERY', id: d.id }, user.name, m,
            { fromShipment: { id: s.id, fallbackLotNumber: s.qrLot || s.shipmentNumber } });
        }
        if (s.productId && isFinal && discrepancy < -QTY_EPS) {
          await this.inventory.record({
            warehouseId: s.destinationWarehouseId, productId: s.productId,
            type: DAMAGE_CONDITIONS.includes(dto.condition) ? 'DAMAGE' : 'LOADING_DISCREPANCY',
            quantity: Math.abs(discrepancy), onHandDelta: 0, reservedDelta: 0, referenceType: 'DELIVERY', referenceId: d.id,
            notes: `${s.shipmentNumber}: loaded ${loaded} MT, received ${cumulative} MT (${discrepancy} MT), condition ${dto.condition}`
          }, user.name, m);
        }

        if (isFinal) {
          change = await this.shipments.setStatus(m, user, s, 'DELIVERED', 'SHIPMENT_DELIVERED', ctx, { deliveredQuantity: cumulative }, {
            deliveryId: d.id, loadedQuantity: loaded, deliveredQuantity: cumulative, discrepancy, finalDelivery: dto.finalDelivery === true
          });
          if (change) change.previousStatus = fromStatus;
        } else {
          await m.getRepository(Shipment).update({ id: s.id }, { deliveredQuantity: cumulative });
          s.deliveredQuantity = cumulative;
          change = change ?? { shipment: s, previousStatus: fromStatus };
        }

        if (flagged) {
          alert = await this.alerts.raise({
            severity: 'HIGH_ORANGE', category: 'Inventory',
            title: `Delivery discrepancy ${s.shipmentNumber}: ${discrepancy > 0 ? '+' : ''}${discrepancy} MT (${dto.condition})`,
            trigger: `Loaded ${loaded} MT, received ${cumulative} MT cumulatively (this delivery ${received} MT), condition ${dto.condition}${isFinal ? '' : ' — partial delivery'}`,
            affectedArea: s.destinationWarehouseId,
            actionRequired: 'Review proof of delivery, investigate the shortage/damage and settle with the transporter',
            sourceType: 'DELIVERY', sourceId: d.id, dedupeKey: `delivery-discrepancy:${d.id}`
          }, m);
        }

        await m.getRepository(TripEvent).insert({
          tripId: trip.id, type: 'NOTE', severity: null,
          description: `Delivery ${isFinal ? 'confirmed' : 'partially confirmed'} for ${s.shipmentNumber}: ${received} MT received by ${dto.receiverName} (${dto.condition})`,
          latitude: null, longitude: null,
          data: { kind: 'DELIVERY', deliveryId: d.id, shipmentId: s.id, receivedQuantity: received, cumulative, discrepancy, condition: dto.condition, final: isFinal },
          recordedBy: user.name, occurredAt: new Date()
        });
        await this.audit.record(user, 'DELIVERY_CONFIRMED', s.id, {
          old: { status: fromStatus, deliveredQuantity: previous }, new: { status: s.status, deliveredQuantity: cumulative },
          deliveryId: d.id, tripId: trip.id, receivedQuantity: received, loadedQuantity: loaded, discrepancy, condition: dto.condition,
          final: isFinal, proofSha256: proofHash, idempotencyKey: key
        }, ctx, m);
        return d;
      });
    } catch (e) {
      if (absPath) await fs.promises.unlink(absPath).catch(() => undefined);
      if (key && uniqueViolation(e)) {
        const existing = await this.ds.getRepository(Delivery).findOne({ where: { idempotencyKey: key } });
        if (existing) return this.replay(existing, shipmentId);
      }
      throw e;
    }

    const c = change as ShipmentChange | null;
    const t = trip as Trip | null;
    const s = c?.shipment ?? (await this.shipments.getRow(shipmentId));
    const entities = {
      shipmentIds: [s.id], warehouseIds: [s.originWarehouseId, s.destinationWarehouseId], tripId: t?.id ?? null,
      truckId: t?.truckId ?? null, driverId: t?.primaryDriverId ?? null
    };
    this.realtime.publish('delivery.confirmed', entities, {
      ...deliveryToFrontend(delivery), shipmentNumber: s.shipmentNumber, shipmentStatus: s.status, deliveredQuantity: s.deliveredQuantity
    });
    if (c) this.shipments.publishShipments([c], { tripId: t?.id, truckId: t?.truckId, driverId: t?.primaryDriverId });
    if (alert) this.realtime.publish('alert.created', { ...entities, alertId: alert.id }, alert);

    return { replayed: false, delivery: deliveryToFrontend(delivery), shipment: await this.shipments.shipmentToFrontend(await this.shipments.getRow(shipmentId)) };
  }

  /** Resolve a proof-of-delivery file for download (access audited as DELIVERY_PROOF_ACCESSED). */
  async proof(user: AuthUser, deliveryId: string, ctx: RequestContext) {
    const d = await this.ds.getRepository(Delivery).findOne({ where: { id: deliveryId } });
    if (!d) throw Errors.notFound('Delivery');
    const s = await this.shipments.getRow(d.shipmentId);
    this.assertDestinationOperator(user, s);
    if (!d.proofOfDeliveryStorageKey) throw Errors.notFound('Proof of delivery');
    const root = this.storageRoot();
    const file = path.resolve(root, d.proofOfDeliveryStorageKey);
    if (!file.startsWith(root + path.sep)) throw Errors.notFound('Proof of delivery');
    if (!fs.existsSync(file)) throw Errors.notFound('Proof of delivery file');
    await this.audit.record(user, 'DELIVERY_PROOF_ACCESSED', d.id, {
      shipmentId: d.shipmentId, shipmentNumber: s.shipmentNumber, proofSha256: d.proofSha256, accessedAt: iso(new Date())
    }, ctx);
    const ext = path.extname(file);
    return { path: file, mimeType: d.proofMimeType || 'application/octet-stream', fileName: `POD-${s.shipmentNumber}-${d.id.slice(0, 8)}${ext}` };
  }
}
