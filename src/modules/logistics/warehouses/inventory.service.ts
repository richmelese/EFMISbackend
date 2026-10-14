import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In } from 'typeorm';
import { RULES } from '../../../common/constants/rules';
import { Errors } from '../../../common/utils/errors';
import { nowStamp, round } from '../../../common/utils/helpers';
import { AlertsService } from '../../alerts/alerts.service';
import { Alert } from '../../alerts/entities/alert.entity';
import { RealtimeService } from '../realtime/realtime.service';
import { InventoryAllocation, InventoryBalance, InventoryLot, InventoryTransaction, Warehouse } from './entities/warehouse.entities';

export type InventoryRefType = 'SHIPMENT' | 'TRIP' | 'DELIVERY' | 'MANUAL' | 'FEED';
export interface InventoryRef {
  type: InventoryRefType;
  id: string;
}

export interface InventoryRecordInput {
  warehouseId: string;
  productId: string;
  /** Ledger type (RECEIPT | DISPATCH | RESERVE | RELEASE | ADJUSTMENT | RETURN | DAMAGE | DELIVERY_RECEIPT | LOADING_DISCREPANCY | TRANSFER_IN | TRANSFER_OUT | QC_STATUS) */
  type: string;
  /** Absolute movement quantity (MT) */
  quantity: number;
  onHandDelta: number;
  reservedDelta: number;
  /** Lot moved — required whenever on-hand or reserved changes */
  lotId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  notes?: string | null;
}

export const QC_STATUSES = ['PASSED', 'PENDING', 'HELD', 'REJECTED'] as const;
export type QcStatus = (typeof QC_STATUSES)[number];

/** Stock entering a warehouse into a named lot. */
export interface LotInput {
  lotNumber?: string | null;
  expiryDate?: string | null;
  qcStatus?: QcStatus | null;
  sourceLotId?: string | null;
}

export interface LotMovement { lotId: string; lotNumber: string; quantity: number; /** ledger row written */ txId?: string }

/** Quantities are MT with up to 3 decimals (kg precision). */
const q = (v: number) => round(v, 3);
const EPS = 1e-6;
const today = () => new Date().toISOString().slice(0, 10);
const usable = (l: InventoryLot) => l.qcStatus === 'PASSED' && !(l.expiryDate && l.expiryDate < today());
const generatedLot = (prefix: string) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/**
 * Auditable, lot-level inventory ledger (Logistics doc §13). Every change is ONE InventoryTransaction row with the signed
 * deltas, the lot moved and the resulting product balance. The product balance (InventoryBalance) is locked first, then
 * lot rows, inside the caller's transaction, so concurrent reservations / dispatches serialise and can never overdraw.
 * Invariants (product and lot): onHand ≥ 0, reserved ≥ 0, reserved ≤ onHand; Σ lots = product balance.
 * Only PASSED, unexpired lots are reservable; loading is refused when an allocated lot is on QC hold or expired.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger('Inventory');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeService
  ) {}

  private run<T>(manager: EntityManager | undefined, work: (m: EntityManager) => Promise<T>): Promise<T> {
    return manager ? work(manager) : this.ds.transaction(work);
  }

  /** Lock (and create when missing) the balance row of a warehouse × product. */
  private async lockBalance(m: EntityManager, warehouseId: string, productId: string): Promise<InventoryBalance> {
    const find = () => m.getRepository(InventoryBalance).createQueryBuilder('b').setLock('pessimistic_write')
      .where('b.warehouseId = :warehouseId AND b.productId = :productId', { warehouseId, productId }).getOne();
    let bal = await find();
    if (!bal) {
      await m.createQueryBuilder().insert().into(InventoryBalance)
        .values({ warehouseId, productId, onHandQuantity: 0, reservedQuantity: 0 }).orIgnore().execute();
      bal = await find();
      if (!bal) throw Errors.conflict('Could not initialise the inventory balance — retry');
    }
    return bal;
  }

  private lockLots(m: EntityManager, warehouseId: string, productId: string) {
    return m.getRepository(InventoryLot).createQueryBuilder('l').setLock('pessimistic_write')
      .where('l.warehouseId = :warehouseId AND l.productId = :productId', { warehouseId, productId })
      .orderBy('l.expiryDate', 'ASC', 'NULLS LAST').addOrderBy('l.receivedAt', 'ASC').addOrderBy('l.lotNumber', 'ASC').getMany();
  }

  /** Core ledger primitive: apply signed deltas to the locked balance (and lot) and append the ledger row. */
  async record(input: InventoryRecordInput, actor: string, manager?: EntityManager): Promise<InventoryTransaction> {
    if (!(input.quantity >= 0) || !Number.isFinite(input.quantity)) throw Errors.unprocessable('Quantity must be a non-negative number');
    if (!Number.isFinite(input.onHandDelta) || !Number.isFinite(input.reservedDelta)) throw Errors.unprocessable('Inventory deltas must be numbers');
    const moves = Math.abs(input.onHandDelta) > EPS || Math.abs(input.reservedDelta) > EPS;
    if (moves && !input.lotId) throw Errors.unprocessable('Stock movements must name a lot');
    return this.run(manager, async m => {
      const wh = await m.getRepository(Warehouse).findOneBy({ id: input.warehouseId });
      if (!wh) throw Errors.notFound('Warehouse');
      const bal = await this.lockBalance(m, input.warehouseId, input.productId);
      const onHandAfter = q(bal.onHandQuantity + input.onHandDelta);
      const reservedAfter = q(bal.reservedQuantity + input.reservedDelta);
      const details = {
        warehouseId: input.warehouseId, productId: input.productId, type: input.type,
        onHand: bal.onHandQuantity, reserved: bal.reservedQuantity, available: q(bal.onHandQuantity - bal.reservedQuantity),
        onHandDelta: input.onHandDelta, reservedDelta: input.reservedDelta
      };
      if (onHandAfter < -EPS) throw Errors.unprocessable(`Insufficient stock at ${wh.name}: on hand ${q(bal.onHandQuantity)} MT, change ${q(input.onHandDelta)} MT`, details);
      if (reservedAfter < -EPS) throw Errors.unprocessable(`Reserved stock at ${wh.name} cannot become negative (reserved ${q(bal.reservedQuantity)} MT)`, details);
      if (onHandAfter + EPS < reservedAfter) {
        throw Errors.unprocessable(`Insufficient available stock at ${wh.name}: available ${q(bal.onHandQuantity - bal.reservedQuantity)} MT`, details);
      }
      if (input.lotId) {
        const lot = await m.getRepository(InventoryLot).createQueryBuilder('l').setLock('pessimistic_write').where('l.id = :id', { id: input.lotId }).getOne();
        if (!lot || lot.warehouseId !== input.warehouseId || lot.productId !== input.productId) throw Errors.unprocessable('Lot does not belong to this warehouse and product');
        const lotOnHand = q(lot.onHandQuantity + input.onHandDelta);
        const lotReserved = q(lot.reservedQuantity + input.reservedDelta);
        const lotDetails = { ...details, lotNumber: lot.lotNumber, lotOnHand: lot.onHandQuantity, lotReserved: lot.reservedQuantity };
        if (lotOnHand < -EPS) throw Errors.unprocessable(`Insufficient stock in lot ${lot.lotNumber}: ${q(lot.onHandQuantity)} MT on hand`, lotDetails);
        if (lotReserved < -EPS || lotOnHand + EPS < lotReserved) throw Errors.unprocessable(`Lot ${lot.lotNumber} has only ${q(lot.onHandQuantity - lot.reservedQuantity)} MT unreserved`, lotDetails);
        await m.getRepository(InventoryLot).update({ id: lot.id }, { onHandQuantity: Math.max(lotOnHand, 0), reservedQuantity: Math.max(lotReserved, 0) });
      }
      await m.getRepository(InventoryBalance).update(
        { warehouseId: input.warehouseId, productId: input.productId },
        { onHandQuantity: Math.max(onHandAfter, 0), reservedQuantity: Math.max(reservedAfter, 0) }
      );
      const tx = await m.getRepository(InventoryTransaction).save(m.getRepository(InventoryTransaction).create({
        warehouseId: input.warehouseId, productId: input.productId, type: input.type, quantity: q(input.quantity),
        onHandDelta: q(input.onHandDelta), reservedDelta: q(input.reservedDelta),
        onHandAfter: Math.max(onHandAfter, 0), reservedAfter: Math.max(reservedAfter, 0), lotId: input.lotId ?? null,
        referenceType: input.referenceType ?? null, referenceId: input.referenceId ?? null, notes: input.notes ?? null,
        createdBy: actor || 'system'
      }));
      if (input.onHandDelta > 0) await this.checkCapacity(input.warehouseId, m);
      return tx;
    });
  }

  // ------------------------------------------------------------------ lots

  /** Find or create a lot (stock entering the warehouse). New lots inherit QC status / expiry from their source lot. */
  private async lotFor(m: EntityManager, warehouseId: string, productId: string, input: LotInput, defaultPrefix: string): Promise<InventoryLot> {
    const repo = m.getRepository(InventoryLot);
    const source = input.sourceLotId ? await repo.findOneBy({ id: input.sourceLotId }) : null;
    const lotNumber = (input.lotNumber || source?.lotNumber || generatedLot(defaultPrefix)).trim().toUpperCase();
    const existing = await repo.findOneBy({ warehouseId, productId, lotNumber });
    if (existing) return existing;
    await repo.createQueryBuilder().insert().into(InventoryLot).values({
      warehouseId, productId, lotNumber,
      qcStatus: input.qcStatus ?? (source?.qcStatus as QcStatus) ?? 'PASSED',
      qcReference: source?.qcReference ?? null,
      expiryDate: input.expiryDate ?? source?.expiryDate ?? null,
      sourceLotId: source?.id ?? null, onHandQuantity: 0, reservedQuantity: 0
    }).orIgnore().execute();
    const lot = await repo.findOneBy({ warehouseId, productId, lotNumber });
    if (!lot) throw Errors.conflict('Could not create the lot — retry');
    return lot;
  }

  /** Add stock to one lot. */
  async deposit(warehouseId: string, productId: string, qty: number, type: string, ref: InventoryRef | { type: string; id: string | null }, actor: string, lot: LotInput, manager?: EntityManager, notes?: string | null): Promise<LotMovement> {
    if (!(qty > 0)) throw Errors.unprocessable('Quantity must be > 0');
    return this.run(manager, async m => {
      await this.lockBalance(m, warehouseId, productId);
      const l = await this.lotFor(m, warehouseId, productId, lot, type === 'RECEIPT' ? 'RCV' : type);
      const tx = await this.record({ warehouseId, productId, type, quantity: qty, onHandDelta: qty, reservedDelta: 0, lotId: l.id, referenceType: ref.type, referenceId: ref.id, notes: notes ?? null }, actor, m);
      return { lotId: l.id, lotNumber: l.lotNumber, quantity: q(qty), txId: tx.id };
    });
  }

  /**
   * Remove unreserved stock (damage, negative adjustment, transfer out). From the named lot, or first-expiry-first-out
   * across lots — usable lots first, then held/pending/expired ones (damage of quarantined stock is valid).
   */
  async withdraw(warehouseId: string, productId: string, qty: number, type: string, ref: { type: string; id: string | null }, actor: string, opts: { lotNumber?: string | null } = {}, manager?: EntityManager, notes?: string | null): Promise<LotMovement[]> {
    if (!(qty > 0)) throw Errors.unprocessable('Quantity must be > 0');
    return this.run(manager, async m => {
      await this.lockBalance(m, warehouseId, productId);
      let lots = await this.lockLots(m, warehouseId, productId);
      if (opts.lotNumber) {
        const want = opts.lotNumber.trim().toUpperCase();
        lots = lots.filter(l => l.lotNumber === want);
        if (!lots.length) throw Errors.unprocessable(`Lot ${want} not found in this warehouse`, { field: 'lotNumber' });
      } else {
        lots = [...lots.filter(usable), ...lots.filter(l => !usable(l))];
      }
      const free = lots.reduce((s, l) => s + Math.max(0, l.onHandQuantity - l.reservedQuantity), 0);
      if (free + EPS < qty) {
        throw Errors.unprocessable(`Insufficient unreserved stock: ${q(free)} MT available to withdraw${opts.lotNumber ? ` in lot ${opts.lotNumber}` : ''}`, { available: q(free), requested: qty });
      }
      let left = qty;
      const out: LotMovement[] = [];
      for (const l of lots) {
        if (left <= EPS) break;
        const take = q(Math.min(left, l.onHandQuantity - l.reservedQuantity));
        if (take <= EPS) continue;
        const tx = await this.record({ warehouseId, productId, type, quantity: take, onHandDelta: -take, reservedDelta: 0, lotId: l.id, referenceType: ref.type, referenceId: ref.id, notes: notes ?? null }, actor, m);
        out.push({ lotId: l.id, lotNumber: l.lotNumber, quantity: take, txId: tx.id });
        left = q(left - take);
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ reservations (shipments)

  /**
   * Reserve stock for a shipment: from `lotNumber` when the shipment names its QR lot, otherwise first-expiry-first-out
   * across PASSED, unexpired lots. 422 with the available / quality-blocked split when not enough usable stock exists.
   */
  async reserve(warehouseId: string, productId: string, qty: number, ref: InventoryRef, actor: string, manager?: EntityManager, opts: { lotNumber?: string | null; preferLotNumber?: string | null } = {}): Promise<LotMovement[]> {
    if (!(qty > 0)) throw Errors.unprocessable('Reservation quantity must be > 0');
    return this.run(manager, async m => {
      const wh = await m.getRepository(Warehouse).findOneBy({ id: warehouseId });
      if (!wh) throw Errors.notFound('Warehouse');
      await this.lockBalance(m, warehouseId, productId);
      const all = await this.lockLots(m, warehouseId, productId);
      let candidates = all.filter(usable);
      // preferLotNumber: the shipment's QR lot — binding when that lot is stocked here, otherwise only a label
      const named = opts.lotNumber || (opts.preferLotNumber && all.some(l => l.lotNumber === opts.preferLotNumber!.trim().toUpperCase()) ? opts.preferLotNumber : null);
      if (named) {
        const want = named.trim().toUpperCase();
        const lot = all.find(l => l.lotNumber === want);
        if (!lot) throw Errors.unprocessable(`Lot ${want} is not stocked at ${wh.name}`, { field: 'qrLot' });
        if (!usable(lot)) throw Errors.unprocessable(`Lot ${want} cannot be reserved: ${lot.qcStatus !== 'PASSED' ? `quality status ${lot.qcStatus}` : `expired ${lot.expiryDate}`}`, { field: 'qrLot', qcStatus: lot.qcStatus, expiryDate: lot.expiryDate });
        candidates = [lot];
      }
      const available = q(candidates.reduce((s, l) => s + Math.max(0, l.onHandQuantity - l.reservedQuantity), 0));
      if (available + EPS < qty) {
        const blocked = q(all.filter(l => !usable(l)).reduce((s, l) => s + l.onHandQuantity, 0));
        throw Errors.unprocessable(`Insufficient available stock at ${wh.name}: available ${available} MT${blocked > EPS ? ` (${blocked} MT more is on quality hold / pending QC / expired)` : ''}`, { available, requested: qty, qualityBlocked: blocked });
      }
      let left = qty;
      const out: LotMovement[] = [];
      const allocs = m.getRepository(InventoryAllocation);
      for (const l of candidates) {
        if (left <= EPS) break;
        const take = q(Math.min(left, l.onHandQuantity - l.reservedQuantity));
        if (take <= EPS) continue;
        await this.record({ warehouseId, productId, type: 'RESERVE', quantity: take, onHandDelta: 0, reservedDelta: take, lotId: l.id, referenceType: ref.type, referenceId: ref.id, notes: `Lot ${l.lotNumber}` }, actor, m);
        const existing = await allocs.findOneBy({ referenceType: ref.type, referenceId: ref.id, lotId: l.id });
        if (existing) await allocs.update({ id: existing.id }, { reservedQuantity: q(existing.reservedQuantity + take) });
        else await allocs.insert({ referenceType: ref.type, referenceId: ref.id, lotId: l.id, warehouseId, productId, reservedQuantity: take, consumedQuantity: 0 });
        out.push({ lotId: l.id, lotNumber: l.lotNumber, quantity: take });
        left = q(left - take);
      }
      return out;
    });
  }

  /** Release (part of) a reservation, most recently allocated lot first. */
  async release(warehouseId: string, productId: string, qty: number, ref: InventoryRef, actor: string, manager?: EntityManager): Promise<void> {
    if (!(qty > 0)) return;
    await this.run(manager, async m => {
      await this.lockBalance(m, warehouseId, productId);
      const allocs = await m.getRepository(InventoryAllocation).find({ where: { referenceType: ref.type, referenceId: ref.id, warehouseId, productId }, order: { createdAt: 'DESC' } });
      let left = qty;
      for (const a of allocs) {
        if (left <= EPS) break;
        const give = q(Math.min(left, a.reservedQuantity));
        if (give <= EPS) continue;
        const lot = await m.getRepository(InventoryLot).findOneBy({ id: a.lotId });
        await this.record({ warehouseId, productId, type: 'RELEASE', quantity: give, onHandDelta: 0, reservedDelta: -give, lotId: a.lotId, referenceType: ref.type, referenceId: ref.id, notes: lot ? `Lot ${lot.lotNumber}` : null }, actor, m);
        await m.getRepository(InventoryAllocation).update({ id: a.id }, { reservedQuantity: q(a.reservedQuantity - give) });
        left = q(left - give);
      }
      if (left > EPS) this.logger.warn(`Release for ${ref.type} ${ref.id}: ${q(left)} MT had no allocation to release`);
    });
  }

  /**
   * Loading completed: the shipment's allocated lots are consumed (reserved → 0) and on-hand decreases by the loaded
   * quantity, lot by lot. Refused when an allocated lot is no longer usable (QC hold / rejected / expired). Extra loaded
   * quantity comes from the same lots first, then other usable lots. A loaded ≠ reserved difference is also noted as a
   * LOADING_DISCREPANCY ledger row (zero balance effect). Returns the lots dispatched (traceability).
   */
  async dispatchLoaded(warehouseId: string, productId: string, loadedQty: number, reservedQty: number, ref: InventoryRef, actor: string, manager?: EntityManager): Promise<LotMovement[]> {
    if (!(loadedQty >= 0) || !(reservedQty >= 0)) throw Errors.unprocessable('Loaded / reserved quantities must be ≥ 0');
    return this.run(manager, async m => {
      await this.lockBalance(m, warehouseId, productId);
      const lots = await this.lockLots(m, warehouseId, productId);
      const byId = new Map(lots.map(l => [l.id, l]));
      const allocRepo = m.getRepository(InventoryAllocation);
      const allocs = (await allocRepo.find({ where: { referenceType: ref.type, referenceId: ref.id, warehouseId, productId }, order: { createdAt: 'ASC' } })).filter(a => a.reservedQuantity > EPS);
      const blocked = allocs.map(a => byId.get(a.lotId)).filter((l): l is InventoryLot => !!l && !usable(l));
      if (blocked.length) {
        throw Errors.unprocessable(`Loading blocked: lot ${blocked.map(l => `${l.lotNumber} (${l.qcStatus !== 'PASSED' ? l.qcStatus : `expired ${l.expiryDate}`})`).join(', ')} cannot be dispatched`, {
          lots: blocked.map(l => ({ lotNumber: l.lotNumber, qcStatus: l.qcStatus, expiryDate: l.expiryDate }))
        });
      }
      const out: LotMovement[] = [];
      let left = loadedQty;
      // 1. consume each allocation: release its reservation and take up to its share
      for (const a of allocs) {
        const lot = byId.get(a.lotId)!;
        const take = q(Math.min(left, a.reservedQuantity));
        await this.record({
          warehouseId, productId, type: 'DISPATCH', quantity: take, onHandDelta: -take, reservedDelta: -a.reservedQuantity, lotId: a.lotId,
          referenceType: ref.type, referenceId: ref.id, notes: `Lot ${lot.lotNumber}${take + EPS < a.reservedQuantity ? ` (reserved ${q(a.reservedQuantity)} MT, loaded ${take} MT)` : ''}`
        }, actor, m);
        await allocRepo.update({ id: a.id }, { reservedQuantity: 0, consumedQuantity: q(a.consumedQuantity + take) });
        lot.onHandQuantity = q(lot.onHandQuantity - take);
        lot.reservedQuantity = q(lot.reservedQuantity - a.reservedQuantity);
        if (take > EPS) out.push({ lotId: lot.id, lotNumber: lot.lotNumber, quantity: take });
        left = q(left - take);
      }
      // 2. loaded more than reserved: same lots first, then other usable lots (FEFO)
      if (left > EPS) {
        const allocated = new Set(allocs.map(a => a.lotId));
        const order = [...lots.filter(l => allocated.has(l.id) && usable(l)), ...lots.filter(l => !allocated.has(l.id) && usable(l))];
        for (const lot of order) {
          if (left <= EPS) break;
          const take = q(Math.min(left, lot.onHandQuantity - lot.reservedQuantity));
          if (take <= EPS) continue;
          await this.record({ warehouseId, productId, type: 'DISPATCH', quantity: take, onHandDelta: -take, reservedDelta: 0, lotId: lot.id, referenceType: ref.type, referenceId: ref.id, notes: `Lot ${lot.lotNumber} (loaded above reservation)` }, actor, m);
          const a = await allocRepo.findOneBy({ referenceType: ref.type, referenceId: ref.id, lotId: lot.id });
          if (a) await allocRepo.update({ id: a.id }, { consumedQuantity: q(a.consumedQuantity + take) });
          else await allocRepo.insert({ referenceType: ref.type, referenceId: ref.id, lotId: lot.id, warehouseId, productId, reservedQuantity: 0, consumedQuantity: take });
          const prev = out.find(o => o.lotId === lot.id);
          if (prev) prev.quantity = q(prev.quantity + take);
          else out.push({ lotId: lot.id, lotNumber: lot.lotNumber, quantity: take });
          left = q(left - take);
        }
        if (left > EPS) throw Errors.unprocessable(`Insufficient usable stock to load ${q(loadedQty)} MT (${q(left)} MT short)`, { short: q(left) });
      }
      const diff = q(loadedQty - reservedQty);
      if (Math.abs(diff) > EPS) {
        await this.record({
          warehouseId, productId, type: 'LOADING_DISCREPANCY', quantity: Math.abs(diff), onHandDelta: 0, reservedDelta: 0, referenceType: ref.type, referenceId: ref.id,
          notes: `Loaded ${q(loadedQty)} MT vs reserved ${q(reservedQty)} MT (${diff > 0 ? '+' : ''}${diff} MT)`
        }, actor, m);
      }
      return out;
    });
  }

  /** Lots (and quantities) loaded for a shipment — used to receive the same lots at the destination. */
  async dispatchedLots(ref: InventoryRef, manager?: EntityManager): Promise<Array<LotMovement & { expiryDate: string | null; qcStatus: string }>> {
    const m = manager ?? this.ds.manager;
    const allocs = await m.getRepository(InventoryAllocation).find({ where: { referenceType: ref.type, referenceId: ref.id }, order: { createdAt: 'ASC' } });
    const used = allocs.filter(a => a.consumedQuantity > EPS);
    if (!used.length) return [];
    const lots = new Map((await m.getRepository(InventoryLot).findBy({ id: In(used.map(a => a.lotId)) })).map(l => [l.id, l]));
    return used.map(a => ({ lotId: a.lotId, lotNumber: lots.get(a.lotId)?.lotNumber ?? '?', quantity: a.consumedQuantity, expiryDate: lots.get(a.lotId)?.expiryDate ?? null, qcStatus: lots.get(a.lotId)?.qcStatus ?? 'PASSED' }));
  }

  /**
   * Stock arriving at a warehouse (supplier receipt, delivery at destination, return, transfer in).
   * With `fromShipment`, the received quantity is split over the lots that shipment loaded (same lot numbers, linked to
   * their source lots); otherwise it enters `lot` (or a generated lot number).
   */
  async receive(
    warehouseId: string, productId: string, qty: number, type: 'RECEIPT' | 'DELIVERY_RECEIPT' | 'RETURN' | 'TRANSFER_IN', ref: InventoryRef, actor: string, manager?: EntityManager,
    opts: { lot?: LotInput; fromShipment?: { id: string; fallbackLotNumber?: string | null } } = {}
  ): Promise<LotMovement[]> {
    if (!(qty > 0)) throw Errors.unprocessable('Received quantity must be > 0');
    return this.run(manager, async m => {
      if (opts.fromShipment) {
        const loaded = await this.dispatchedLots({ type: 'SHIPMENT', id: opts.fromShipment.id }, m);
        const total = loaded.reduce((s, l) => s + l.quantity, 0);
        if (loaded.length && total > EPS) {
          const out: LotMovement[] = [];
          let left = qty;
          loaded.forEach((l, i) => {
            (l as any).share = i === loaded.length - 1 ? null : q((qty * l.quantity) / total);
          });
          for (const l of loaded) {
            const share = (l as any).share === null ? q(left) : Math.min((l as any).share, left);
            if (share <= EPS) continue;
            out.push(await this.deposit(warehouseId, productId, share, type, ref, actor, { lotNumber: l.lotNumber, sourceLotId: l.lotId }, m));
            left = q(left - share);
          }
          return out;
        }
        return [await this.deposit(warehouseId, productId, qty, type, ref, actor, { lotNumber: opts.fromShipment.fallbackLotNumber ?? null }, m)];
      }
      return [await this.deposit(warehouseId, productId, qty, type, ref, actor, opts.lot ?? {}, m)];
    });
  }

  // ------------------------------------------------------------------ quality control

  async listLots(warehouseId: string, opts: { productId?: string; qcStatus?: string; includeEmpty?: boolean } = {}) {
    const qb = this.ds.getRepository(InventoryLot).createQueryBuilder('l').where('l.warehouseId = :warehouseId', { warehouseId });
    if (opts.productId) qb.andWhere('l.productId = :productId', { productId: opts.productId });
    if (opts.qcStatus) qb.andWhere('l.qcStatus IN (:...st)', { st: opts.qcStatus.split(',').map(s => s.trim().toUpperCase()) });
    if (!opts.includeEmpty) qb.andWhere(new Brackets(b => b.where('l.onHandQuantity > 0').orWhere('l.reservedQuantity > 0')));
    const rows = await qb.orderBy('l.productId').addOrderBy('l.expiryDate', 'ASC', 'NULLS LAST').addOrderBy('l.receivedAt', 'ASC').getMany();
    return rows.map(l => this.lotToFrontend(l));
  }

  lotToFrontend(l: InventoryLot) {
    const expired = !!(l.expiryDate && l.expiryDate < today());
    return {
      id: l.id, warehouseId: l.warehouseId, productId: l.productId, lotNumber: l.lotNumber, qcStatus: l.qcStatus, qcReference: l.qcReference,
      qcNotes: l.qcNotes, qcDecidedBy: l.qcDecidedBy, qcDecidedAt: l.qcDecidedAt?.toISOString?.() ?? null, expiryDate: l.expiryDate, expired,
      usable: usable(l), onHand: q(l.onHandQuantity), reserved: q(l.reservedQuantity), available: usable(l) ? q(l.onHandQuantity - l.reservedQuantity) : 0,
      sourceLotId: l.sourceLotId, receivedAt: l.receivedAt?.toISOString?.() ?? null, updatedAt: l.updatedAt?.toISOString?.() ?? null
    };
  }

  /**
   * Quality decision on a lot (ECAE / quality officer). HELD or REJECTED makes the lot unreservable and blocks loading of
   * shipments already holding it — those are listed in a CRITICAL 'Inventory' alert so dispatch can re-plan.
   */
  async setLotQc(lotId: string, input: { status: QcStatus; reference?: string | null; notes?: string | null }, actor: string, manager?: EntityManager) {
    if (!QC_STATUSES.includes(input.status)) throw Errors.unprocessable(`qcStatus must be one of ${QC_STATUSES.join(', ')}`);
    return this.run(manager, async m => {
      const lot = await m.getRepository(InventoryLot).createQueryBuilder('l').setLock('pessimistic_write').where('l.id = :id', { id: lotId }).getOne();
      if (!lot) throw Errors.notFound('Lot');
      if (lot.qcStatus === 'REJECTED' && input.status !== 'REJECTED') throw Errors.unprocessable('A rejected lot cannot be released; record a new lot after re-testing');
      const before = lot.qcStatus;
      await m.getRepository(InventoryLot).update({ id: lot.id }, {
        qcStatus: input.status, qcReference: input.reference ?? lot.qcReference, qcNotes: input.notes ?? null, qcDecidedBy: actor, qcDecidedAt: new Date()
      });
      await this.record({
        warehouseId: lot.warehouseId, productId: lot.productId, type: 'QC_STATUS', quantity: 0, onHandDelta: 0, reservedDelta: 0, lotId: lot.id,
        referenceType: 'MANUAL', referenceId: input.reference ?? null, notes: `Lot ${lot.lotNumber}: ${before} → ${input.status}${input.notes ? ` — ${input.notes}` : ''}`
      }, actor, m);
      let affected: string[] = [];
      if ((input.status === 'HELD' || input.status === 'REJECTED') && lot.reservedQuantity > EPS) {
        const allocs = await m.getRepository(InventoryAllocation).find({ where: { lotId: lot.id } });
        const shipIds = allocs.filter(a => a.reservedQuantity > EPS && a.referenceType === 'SHIPMENT').map(a => a.referenceId);
        affected = shipIds.length ? (await m.query('SELECT shipment_number FROM shipments WHERE id = ANY($1::uuid[])', [shipIds])).map((r: any) => r.shipment_number) : [];
        const wh = await m.getRepository(Warehouse).findOneBy({ id: lot.warehouseId });
        const alert = await this.alerts.raise({
          severity: 'CRITICAL_RED', title: `Lot ${lot.lotNumber} on quality ${input.status === 'HELD' ? 'hold' : 'rejection'} — ${affected.length} shipment(s) blocked`,
          category: 'Inventory', trigger: `${q(lot.reservedQuantity)} MT of lot ${lot.lotNumber} at ${wh?.name ?? 'warehouse'} is reserved for ${affected.join(', ') || 'shipments'}`,
          affectedArea: wh?.name ?? null, actionRequired: 'Re-plan the affected shipments with another lot or hold them until QC releases the lot.',
          sourceType: 'WAREHOUSE', sourceId: lot.warehouseId, dedupeKey: `LOT-QC-${lot.id}-${input.status}`
        }, m);
        this.realtime.publish('alert.created', { alertId: alert.id, warehouseIds: [lot.warehouseId], shipmentIds: shipIds }, alert);
      }
      const after = await m.getRepository(InventoryLot).findOneByOrFail({ id: lot.id });
      return { lot: this.lotToFrontend(after), previousStatus: before, blockedShipments: affected };
    });
  }

  // ------------------------------------------------------------------ balances

  async balance(warehouseId: string, productId: string): Promise<{ onHand: number; reserved: number; available: number; qualityBlocked: number }> {
    const [b, lots] = await Promise.all([
      this.ds.getRepository(InventoryBalance).findOneBy({ warehouseId, productId }),
      this.ds.getRepository(InventoryLot).findBy({ warehouseId, productId })
    ]);
    const onHand = q(b?.onHandQuantity ?? 0);
    const reserved = q(b?.reservedQuantity ?? 0);
    const available = q(lots.filter(usable).reduce((s, l) => s + Math.max(0, l.onHandQuantity - l.reservedQuantity), 0));
    const qualityBlocked = q(lots.filter(l => !usable(l)).reduce((s, l) => s + l.onHandQuantity, 0));
    return { onHand, reserved, available, qualityBlocked };
  }

  /** Per product of a warehouse: usable available stock and quality-blocked stock (from lots). */
  async lotSummary(warehouseId: string): Promise<Map<string, { available: number; qualityBlocked: number; lots: number }>> {
    const lots = await this.ds.getRepository(InventoryLot).findBy({ warehouseId });
    const map = new Map<string, { available: number; qualityBlocked: number; lots: number }>();
    for (const l of lots) {
      const e = map.get(l.productId) ?? { available: 0, qualityBlocked: 0, lots: 0 };
      if (l.onHandQuantity > EPS) e.lots += 1;
      if (usable(l)) e.available = q(e.available + Math.max(0, l.onHandQuantity - l.reservedQuantity));
      else e.qualityBlocked = q(e.qualityBlocked + l.onHandQuantity);
      map.set(l.productId, e);
    }
    return map;
  }

  /** Σ on-hand / reserved of one warehouse across products. */
  async totals(warehouseId: string, manager?: EntityManager): Promise<{ onHand: number; reserved: number }> {
    const r = await (manager ?? this.ds.manager).getRepository(InventoryBalance).createQueryBuilder('b')
      .select('COALESCE(SUM(b.onHandQuantity), 0)', 'onHand').addSelect('COALESCE(SUM(b.reservedQuantity), 0)', 'reserved')
      .where('b.warehouseId = :warehouseId', { warehouseId }).getRawOne<{ onHand: string; reserved: string }>();
    return { onHand: q(Number(r?.onHand) || 0), reserved: q(Number(r?.reserved) || 0) };
  }

  /**
   * Storage capacity alert (REQ-INT-003): Σ onHand / capacityMt ≥ 80% → HIGH_ORANGE 'Logistics & Warehousing'
   * (de-duplicated per warehouse per day). Returns the utilisation percentage.
   */
  async checkCapacity(warehouseId: string, manager?: EntityManager): Promise<number> {
    const m = manager ?? this.ds.manager;
    const wh = await m.getRepository(Warehouse).findOneBy({ id: warehouseId });
    if (!wh || !(wh.capacityMt > 0)) return 0;
    const { onHand } = await this.totals(warehouseId, m);
    const util = round((onHand / wh.capacityMt) * 100, 1);
    if (util < RULES.warehouseCapacityAlertPct) return util;
    const dedupeKey = `WH-CAP-${wh.id}-${nowStamp().slice(0, 10)}`;
    const existed = await m.getRepository(Alert).exists({ where: { dedupeKey } });
    const alert = await this.alerts.raise({
      severity: 'HIGH_ORANGE', title: `Storage Capacity Exceeded ${RULES.warehouseCapacityAlertPct}% at ${wh.name}`, category: 'Logistics & Warehousing',
      trigger: `Total inventory reached ${onHand.toLocaleString('en-US')} MT against ${wh.capacityMt.toLocaleString('en-US')} MT max design threshold (${util}%)`,
      affectedArea: wh.name, actionRequired: 'Accelerate secondary transport dispatches to union warehouses.', sourceType: 'WAREHOUSE', sourceId: wh.id, dedupeKey
    }, m);
    if (!existed) {
      this.realtime.publish('alert.created', { alertId: alert.id, warehouseIds: [wh.id] }, alert);
      this.logger.log(`Capacity alert raised for ${wh.code} (${util}%)`);
    }
    return util;
  }
}
