import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, QueryFailedError, Repository } from 'typeorm';
import { FLEET_WIDE_ROLES, Role } from '../../../common/constants/permissions';
import { RULES } from '../../../common/constants/rules';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { isValidCoordinate } from '../../../common/utils/geo';
import { round } from '../../../common/utils/helpers';
import { applySearch } from '../../../common/utils/query-filters';
import { AuditService } from '../../audit/audit.service';
import { Paged, pageParams } from '../logistics.constants';
import {
  CreateInventoryTransactionDto, CreateProductDto, CreateWarehouseDto, DiscrepancyQueryDto, InventoryTxQueryDto, ProductQueryDto, UpdateWarehouseDto,
  LotQcDto, LotQueryDto, WarehouseQueryDto
} from './dto/warehouses.dto';
import { InventoryBalance, InventoryLot, InventoryTransaction, Product, Warehouse } from './entities/warehouse.entities';
import { InventoryService } from './inventory.service';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
export const DISCREPANCY_TYPES = ['LOADING_DISCREPANCY', 'DAMAGE', 'ADJUSTMENT'];

const isUniqueViolation = (e: unknown) => e instanceof QueryFailedError && (e as any).driverError?.code === '23505';

/** Warehouses, products and the inventory ledger endpoints (Logistics doc §13, §15). */
@Injectable()
export class WarehousesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Warehouse) readonly warehouses: Repository<Warehouse>,
    @InjectRepository(Product) readonly products: Repository<Product>,
    @InjectRepository(InventoryBalance) readonly balances: Repository<InventoryBalance>,
    @InjectRepository(InventoryTransaction) readonly transactions: Repository<InventoryTransaction>,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService
  ) {}

  // ---------------- scoping ----------------
  /** WAREHOUSE_OPERATOR may only act on / read the inventory of user.warehouseId. */
  assertWarehouseAccess(user: AuthUser, warehouseId: string) {
    if (user.role === Role.WAREHOUSE_OPERATOR && user.warehouseId !== warehouseId) {
      throw Errors.forbidden('Warehouse operators can only access the inventory of their own warehouse');
    }
  }

  private isFleetWide(user: AuthUser) {
    return FLEET_WIDE_ROLES.includes(user.role);
  }

  // ---------------- mappers ----------------
  async warehouseToFrontend(w: Warehouse): Promise<any> {
    const t = await this.inventory.totals(w.id);
    return this.warehouseOut(w, t.onHand, t.reserved);
  }

  private warehouseOut(w: Warehouse, onHand: number, reserved: number) {
    const util = w.capacityMt > 0 ? round((onHand / w.capacityMt) * 100, 1) : 0;
    return {
      id: w.id, code: w.code, name: w.name, kind: w.kind, address: w.address, latitude: w.latitude, longitude: w.longitude,
      capacityMt: w.capacityMt, regionId: w.regionId, status: w.status, sort: w.sort,
      currentStockMt: round(onHand, 3), reservedMt: round(reserved, 3), availableMt: round(onHand - reserved, 3), utilPercent: util,
      capacityStatus: util >= RULES.warehouseCapacityAlertPct ? 'CAPACITY_ALERT_80' : 'OPTIMAL',
      createdAt: iso(w.createdAt), updatedAt: iso(w.updatedAt)
    };
  }

  productOut(p: Product) {
    return { id: p.id, sku: p.sku, name: p.name, unit: p.unit, cargoType: p.cargoType, active: p.active };
  }

  txOut(t: InventoryTransaction, names?: { warehouses?: Map<string, Warehouse>; products?: Map<string, Product>; lots?: Map<string, InventoryLot> }) {
    const w = names?.warehouses?.get(t.warehouseId);
    const p = names?.products?.get(t.productId);
    return {
      id: t.id, warehouseId: t.warehouseId, warehouseName: w?.name ?? null, productId: t.productId, productSku: p?.sku ?? null,
      type: t.type, quantity: t.quantity, onHandDelta: t.onHandDelta, reservedDelta: t.reservedDelta, onHandAfter: t.onHandAfter, reservedAfter: t.reservedAfter,
      lotId: t.lotId, lotNumber: t.lotId ? names?.lots?.get(t.lotId)?.lotNumber ?? null : null,
      referenceType: t.referenceType, referenceId: t.referenceId, notes: t.notes, createdBy: t.createdBy, createdAt: iso(t.createdAt)
    };
  }

  private async txPage(rows: InventoryTransaction[]) {
    const wIds = [...new Set(rows.map(r => r.warehouseId))];
    const pIds = [...new Set(rows.map(r => r.productId))];
    const warehouses = new Map((wIds.length ? await this.warehouses.findBy({ id: In(wIds) }) : []).map(w => [w.id, w] as const));
    const products = new Map((pIds.length ? await this.products.findBy({ id: In(pIds) }) : []).map(p => [p.id, p] as const));
    const lIds = [...new Set(rows.map(r => r.lotId).filter((x): x is string => !!x))];
    const lots = new Map((lIds.length ? await this.ds.getRepository(InventoryLot).findBy({ id: In(lIds) }) : []).map(l => [l.id, l] as const));
    return rows.map(r => this.txOut(r, { warehouses, products, lots }));
  }

  // ---------------- warehouses ----------------
  async list(q: WarehouseQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.warehouses.createQueryBuilder('w');
    if (q.kind) qb.andWhere('w.kind = :kind', { kind: q.kind });
    if (q.status) qb.andWhere('w.status = :status', { status: q.status });
    if (q.regionId) qb.andWhere('w.regionId = :regionId', { regionId: q.regionId });
    applySearch(qb, ['w.code', 'w.name'], q.q);
    const [rows, total] = await qb.orderBy('w.sort', 'ASC').addOrderBy('w.name', 'ASC').skip(skip).take(take).getManyAndCount();
    const sums = await this.sumsFor(rows.map(r => r.id));
    return { items: rows.map(w => this.warehouseOut(w, sums.get(w.id)?.onHand ?? 0, sums.get(w.id)?.reserved ?? 0)), total, page, pageSize };
  }

  async sumsFor(ids: string[]): Promise<Map<string, { onHand: number; reserved: number }>> {
    if (!ids.length) return new Map();
    const rows = await this.balances.createQueryBuilder('b')
      .select('b.warehouseId', 'warehouseId').addSelect('COALESCE(SUM(b.onHandQuantity), 0)', 'onHand').addSelect('COALESCE(SUM(b.reservedQuantity), 0)', 'reserved')
      .where('b.warehouseId IN (:...ids)', { ids }).groupBy('b.warehouseId').getRawMany<{ warehouseId: string; onHand: string; reserved: string }>();
    return new Map(rows.map(r => [r.warehouseId, { onHand: Number(r.onHand) || 0, reserved: Number(r.reserved) || 0 }]));
  }

  async findOne(id: string): Promise<Warehouse> {
    const w = await this.warehouses.findOneBy({ id });
    if (!w) throw Errors.notFound('Warehouse');
    return w;
  }

  async get(id: string) {
    return this.warehouseToFrontend(await this.findOne(id));
  }

  private assertCoordinates(lat: number | null | undefined, lng: number | null | undefined) {
    if (lat === undefined && lng === undefined) return;
    if (lat === null && lng === null) return;
    if (!isValidCoordinate(lat, lng)) throw Errors.unprocessable('latitude/longitude must be a valid WGS-84 coordinate pair', { latitude: lat, longitude: lng });
  }

  private async assertUnique(m: EntityManager, code: string | undefined, name: string | undefined, exceptId?: string) {
    const repo = m.getRepository(Warehouse);
    if (code) {
      const c = await repo.createQueryBuilder('w').where('UPPER(w.code) = :code', { code: code.toUpperCase() }).getOne();
      if (c && c.id !== exceptId) throw Errors.conflict(`Warehouse code ${code} already exists`);
    }
    if (name) {
      const n = await repo.createQueryBuilder('w').where('LOWER(w.name) = :name', { name: name.toLowerCase() }).getOne();
      if (n && n.id !== exceptId) throw Errors.conflict(`Warehouse name "${name}" already exists`);
    }
  }

  async create(user: AuthUser, dto: CreateWarehouseDto, ctx: RequestContext) {
    this.assertCoordinates(dto.latitude, dto.longitude);
    try {
      const saved = await this.ds.transaction(async m => {
        await this.assertUnique(m, dto.code, dto.name);
        const repo = m.getRepository(Warehouse);
        const sort = dto.sort ?? (await repo.count());
        const w = await repo.save(repo.create({
          code: dto.code, name: dto.name, kind: dto.kind || 'REGIONAL_DEPOT', address: dto.address ?? null,
          latitude: dto.latitude ?? null, longitude: dto.longitude ?? null, capacityMt: dto.capacityMt, regionId: dto.regionId ?? null,
          status: dto.status || 'ACTIVE', sort
        }));
        await this.audit.record(user, 'WAREHOUSE_CREATED', w.id, { new: { ...dto } }, ctx, m);
        return w;
      });
      return this.warehouseToFrontend(saved);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Warehouse code or name already exists');
      throw e;
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateWarehouseDto, ctx: RequestContext) {
    try {
      const saved = await this.ds.transaction(async m => {
        const repo = m.getRepository(Warehouse);
        const w = await repo.createQueryBuilder('w').setLock('pessimistic_write').where('w.id = :id', { id }).getOne();
        if (!w) throw Errors.notFound('Warehouse');
        await this.assertUnique(m, dto.code, dto.name, id);
        const lat = dto.latitude !== undefined ? dto.latitude : w.latitude;
        const lng = dto.longitude !== undefined ? dto.longitude : w.longitude;
        if (dto.latitude !== undefined || dto.longitude !== undefined) this.assertCoordinates(lat, lng);
        const old = { ...w };
        const { reason, ...changes } = dto;
        const patch = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<Warehouse>;
        if (!Object.keys(patch).length) return w;
        repo.merge(w, patch);
        await repo.save(w);
        const diffOld: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) diffOld[k] = (old as any)[k];
        await this.audit.record(user, 'WAREHOUSE_UPDATED', w.id, { old: diffOld, new: patch, reason: reason ?? null }, ctx, m);
        if (patch.capacityMt !== undefined) await this.inventory.checkCapacity(w.id, m);
        return w;
      });
      return this.warehouseToFrontend(saved);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Warehouse code or name already exists');
      throw e;
    }
  }

  /** Balances per product with onHand / reserved / available and the share of the warehouse capacity. */
  async inventoryOf(user: AuthUser, id: string) {
    this.assertWarehouseAccess(user, id);
    const w = await this.findOne(id);
    const rows = await this.balances.find({ where: { warehouseId: id } });
    const lotSummary = await this.inventory.lotSummary(id);
    const products = new Map((rows.length ? await this.products.findBy({ id: In(rows.map(r => r.productId)) }) : []).map(p => [p.id, p] as const));
    const items = rows
      .map(b => {
        const p = products.get(b.productId);
        return {
          productId: b.productId, sku: p?.sku ?? null, productName: p?.name ?? null, unit: p?.unit ?? 'MT',
          onHand: round(b.onHandQuantity, 3), reserved: round(b.reservedQuantity, 3),
          // usable = PASSED, unexpired lots; stock on quality hold / pending QC / expired is on hand but not available
          available: lotSummary.get(b.productId)?.available ?? 0, qualityBlocked: lotSummary.get(b.productId)?.qualityBlocked ?? 0,
          lots: lotSummary.get(b.productId)?.lots ?? 0,
          utilPercent: w.capacityMt > 0 ? round((b.onHandQuantity / w.capacityMt) * 100, 1) : 0, updatedAt: iso(b.updatedAt)
        };
      })
      .sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    const onHand = items.reduce((s, i) => s + i.onHand, 0);
    const reserved = items.reduce((s, i) => s + i.reserved, 0);
    return { warehouse: this.warehouseOut(w, onHand, reserved), items };
  }

  async lots(user: AuthUser, id: string, q: LotQueryDto) {
    this.assertWarehouseAccess(user, id);
    await this.findOne(id);
    const items = await this.inventory.listLots(id, { productId: q.productId, qcStatus: q.qcStatus, includeEmpty: q.includeEmpty === 'true' });
    const products = new Map((await this.products.find()).map(p => [p.id, p] as const));
    return items.map(l => ({ ...l, sku: products.get(l.productId)?.sku ?? null, productName: products.get(l.productId)?.name ?? null }));
  }

  async getLot(user: AuthUser, lotId: string) {
    const lot = await this.ds.getRepository(InventoryLot).findOneBy({ id: lotId });
    if (!lot) throw Errors.notFound('Lot');
    this.assertWarehouseAccess(user, lot.warehouseId);
    const [wh, product] = await Promise.all([this.warehouses.findOneBy({ id: lot.warehouseId }), this.products.findOneBy({ id: lot.productId })]);
    return { ...this.inventory.lotToFrontend(lot), warehouseCode: wh?.code ?? null, warehouseName: wh?.name ?? null, sku: product?.sku ?? null, productName: product?.name ?? null };
  }

  async setLotQc(user: AuthUser, lotId: string, dto: LotQcDto, ctx: RequestContext) {
    const lot = await this.ds.getRepository(InventoryLot).findOneBy({ id: lotId });
    if (!lot) throw Errors.notFound('Lot');
    this.assertWarehouseAccess(user, lot.warehouseId);
    return this.ds.transaction(async m => {
      const res = await this.inventory.setLotQc(lotId, { status: dto.status, reference: dto.reference ?? null, notes: dto.notes ?? null }, user.name, m);
      await this.audit.record(user, 'INVENTORY_LOT_QC', lotId, {
        lotNumber: lot.lotNumber, warehouseId: lot.warehouseId, old: { qcStatus: res.previousStatus }, new: { qcStatus: dto.status, reference: dto.reference ?? null },
        reason: dto.notes ?? null, blockedShipments: res.blockedShipments
      }, ctx, m);
      return res;
    });
  }

  async discrepancies(user: AuthUser, id: string, q: DiscrepancyQueryDto): Promise<Paged<any>> {
    this.assertWarehouseAccess(user, id);
    await this.findOne(id);
    return this.listTransactions(user, { ...q, warehouseId: id, type: DISCREPANCY_TYPES.join(',') });
  }

  // ---------------- products ----------------
  async listProducts(q: ProductQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const [rows, total] = await this.products.findAndCount({
      where: q.active === undefined ? {} : { active: q.active }, order: { sku: 'ASC' }, skip, take
    });
    return { items: rows.map(p => this.productOut(p)), total, page, pageSize };
  }

  async createProduct(user: AuthUser, dto: CreateProductDto, ctx: RequestContext) {
    try {
      const p = await this.ds.transaction(async m => {
        const repo = m.getRepository(Product);
        if (await repo.exists({ where: { sku: dto.sku } })) throw Errors.conflict(`Product SKU ${dto.sku} already exists`);
        const saved = await repo.save(repo.create({
          sku: dto.sku, name: dto.name, unit: dto.unit || 'MT', cargoType: dto.cargoType || 'BAGGED_FERTILIZER', active: dto.active ?? true
        }));
        await this.audit.record(user, 'PRODUCT_CREATED', saved.id, { new: { ...dto } }, ctx, m);
        return saved;
      });
      return this.productOut(p);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict(`Product SKU ${dto.sku} already exists`);
      throw e;
    }
  }

  // ---------------- ledger ----------------
  async listTransactions(user: AuthUser, q: InventoryTxQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.transactions.createQueryBuilder('t');
    if (user.role === Role.WAREHOUSE_OPERATOR) {
      if (q.warehouseId && q.warehouseId !== user.warehouseId) throw Errors.forbidden('Warehouse operators can only access the inventory of their own warehouse');
      qb.andWhere('t.warehouseId = :own', { own: user.warehouseId ?? '00000000-0000-0000-0000-000000000000' });
    } else if (!this.isFleetWide(user) && user.role !== Role.REGION) {
      throw Errors.forbidden();
    }
    if (q.warehouseId) qb.andWhere('t.warehouseId = :warehouseId', { warehouseId: q.warehouseId });
    if (q.productId) qb.andWhere('t.productId = :productId', { productId: q.productId });
    if (q.type) {
      const types = q.type.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (types.length) qb.andWhere('t.type IN (:...types)', { types });
    }
    if (q.referenceType) qb.andWhere('t.referenceType = :referenceType', { referenceType: q.referenceType.toUpperCase() });
    if (q.referenceId) qb.andWhere('t.referenceId = :referenceId', { referenceId: q.referenceId });
    if (q.from) qb.andWhere('t.createdAt >= :from', { from: new Date(q.from) });
    if (q.to) qb.andWhere('t.createdAt <= :to', { to: new Date(q.to) });
    const [rows, total] = await qb.orderBy('t.createdAt', 'DESC').addOrderBy('t.id', 'ASC').skip(skip).take(take).getManyAndCount();
    return { items: await this.txPage(rows), total, page, pageSize };
  }

  /**
   * Manual ledger movement (receipt, adjustment, return, damage, transfer) — one DB transaction, row-locked balances, audited.
   * TRANSFER locks both balances in a stable (warehouse id) order to avoid deadlocks with a concurrent reverse transfer.
   */
  async postTransaction(user: AuthUser, dto: CreateInventoryTransactionDto, ctx: RequestContext) {
    this.assertWarehouseAccess(user, dto.warehouseId);
    if ((dto.type === 'ADJUSTMENT' || dto.type === 'DAMAGE') && !(dto.notes && dto.notes.trim().length >= 3)) {
      throw Errors.unprocessable(`notes are required for ${dto.type}`);
    }
    if (dto.type === 'TRANSFER' && dto.toWarehouseId === dto.warehouseId) throw Errors.unprocessable('Transfer source and destination must differ');
    const actor = user.name;
    const refType = dto.referenceType || 'MANUAL';
    const notes = dto.notes?.trim() || null;

    const rows = await this.ds.transaction(async m => {
      const product = await m.getRepository(Product).findOneBy({ id: dto.productId });
      if (!product) throw Errors.notFound('Product');
      const source = await m.getRepository(Warehouse).findOneBy({ id: dto.warehouseId });
      if (!source) throw Errors.notFound('Warehouse');
      const qty = dto.quantity ?? 0;
      const ref = { type: refType, id: dto.referenceId ?? null };
      const moved: Array<{ warehouseId: string; type: string; lotNumber: string; quantity: number; txId?: string }> = [];
      const push = (warehouseId: string, type: string, list: Array<{ lotNumber: string; quantity: number; txId?: string }>) => list.forEach(l => moved.push({ warehouseId, type, lotNumber: l.lotNumber, quantity: l.quantity, txId: l.txId }));
      const lotIn = { lotNumber: dto.lotNumber ?? null, expiryDate: dto.expiryDate ?? null, qcStatus: dto.qcStatus ?? null };
      switch (dto.type) {
        case 'RECEIPT':
        case 'RETURN':
          push(source.id, dto.type, [await this.inventory.deposit(source.id, product.id, qty, dto.type, ref, actor, lotIn, m, notes)]);
          break;
        case 'DAMAGE':
          push(source.id, 'DAMAGE', await this.inventory.withdraw(source.id, product.id, qty, 'DAMAGE', ref, actor, { lotNumber: dto.lotNumber }, m, notes));
          break;
        case 'ADJUSTMENT': {
          const delta = dto.onHandDelta ?? 0;
          if (!delta) throw Errors.unprocessable('onHandDelta must be a non-zero number for ADJUSTMENT');
          push(source.id, 'ADJUSTMENT', delta > 0
            ? [await this.inventory.deposit(source.id, product.id, delta, 'ADJUSTMENT', ref, actor, lotIn, m, notes)]
            : await this.inventory.withdraw(source.id, product.id, -delta, 'ADJUSTMENT', ref, actor, { lotNumber: dto.lotNumber }, m, notes));
          break;
        }
        case 'TRANSFER': {
          const dest = await m.getRepository(Warehouse).findOneBy({ id: dto.toWarehouseId! });
          if (!dest) throw Errors.notFound('Destination warehouse');
          const transferRef = { type: refType, id: dto.referenceId || `TRF-${Date.now().toString(36).toUpperCase()}` };
          // Lock both product balances in a stable order (deadlock-free against a concurrent reverse transfer)
          for (const id of [source.id, dest.id].sort()) {
            await m.query('SELECT 1 FROM inventory_balances WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE', [id, product.id]);
          }
          const outLots = await this.inventory.withdraw(source.id, product.id, qty, 'TRANSFER_OUT', transferRef, actor, { lotNumber: dto.lotNumber }, m, notes ?? `Transfer to ${dest.name}`);
          push(source.id, 'TRANSFER_OUT', outLots);
          for (const l of outLots) {
            push(dest.id, 'TRANSFER_IN', [await this.inventory.deposit(dest.id, product.id, l.quantity, 'TRANSFER_IN', transferRef, actor, { lotNumber: l.lotNumber, sourceLotId: l.lotId }, m, notes ?? `Transfer from ${source.name}`)]);
          }
          break;
        }
        default:
          throw Errors.unprocessable(`Unsupported manual transaction type ${dto.type}`);
      }
      // The ledger rows this command wrote, for the response and the audit entry
      const txIds = moved.map(x => x.txId).filter((x): x is string => !!x);
      const out = await m.getRepository(InventoryTransaction).findBy({ id: In(txIds) });
      out.sort((a, b) => (a.type === 'TRANSFER_OUT' ? -1 : b.type === 'TRANSFER_OUT' ? 1 : 0));
      await this.audit.record(user, `INVENTORY_${dto.type}`, out[0].id, {
        new: out.map(t => ({ id: t.id, warehouseId: t.warehouseId, productSku: product.sku, type: t.type, onHandDelta: t.onHandDelta, onHandAfter: t.onHandAfter, reservedAfter: t.reservedAfter })),
        lots: moved,
        reason: notes
      }, ctx, m);
      return out;
    });
    const items = await this.txPage(rows);
    return dto.type === 'TRANSFER' || items.length > 1 ? { items } : items[0];
  }
}
