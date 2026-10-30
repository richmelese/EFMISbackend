import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { DailySummaryDate, DailySummaryRecord, DispatchWaybill, LotUnion, ReportRegion, UnionDailyLoad, VesselLot } from './entities/report.entities';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { isNational, visibleRows } from '../../common/utils/scope';
import { round, stamp, toCsv } from '../../common/utils/helpers';
import { AuditService } from '../audit/audit.service';
import { AddLotUnionDto, CreateLotDto, CreateReportDateDto, DailySummaryQuery, DispatchEntryDto, LotDateDto, UnionLoadDto, UpdateDailyRecordDto } from './dto/reports.dto';

/** API field (frontend) -> entity property */
const NUM_FIELDS = {
  procuredMT: 'procuredMt', regionalStockMT: 'regionalStockMt', dispatchedMT: 'dispatchedMt', portCumulativeMT: 'portCumulativeMt',
  portDailyMT: 'portDailyMt', currentRegionStockMT: 'currentRegionStockMt', deliveredToRegionMT: 'deliveredToRegionMt', queueMT: 'queueMt',
  hubThisWeekMT: 'hubThisWeekMt', hubCumulativeMT: 'hubCumulativeMt'
} as const;
type NumField = keyof typeof NUM_FIELDS;
const NUM_KEYS = Object.keys(NUM_FIELDS) as NumField[];

export type RecordOut = { regionId: string; regionName: string; fertilizerType: string } & Record<NumField, number>;

/** Frontend union ids ("u1") are unique per lot only; stored ids are "<lotId>:<shortId>". */
const unionShortId = (id: string) => id.split(':').slice(1).join(':') || id;
const resolveUnionId = (lotId: string, unionId: string) => (unionId.includes(':') ? unionId : `${lotId}:${unionId}`);

/** Daily operational reports (frontend "Daily Reports Hub"). */
@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(DailySummaryDate) private readonly dates: Repository<DailySummaryDate>,
    @InjectRepository(DailySummaryRecord) private readonly records: Repository<DailySummaryRecord>,
    @InjectRepository(ReportRegion) private readonly reportRegions: Repository<ReportRegion>,
    @InjectRepository(VesselLot) private readonly lots: Repository<VesselLot>,
    @InjectRepository(LotUnion) private readonly unions: Repository<LotUnion>,
    @InjectRepository(UnionDailyLoad) private readonly loads: Repository<UnionDailyLoad>,
    @InjectRepository(DispatchWaybill) private readonly waybills: Repository<DispatchWaybill>,
    private readonly audit: AuditService
  ) {}

  // ===================== Daily Fertilizer Summary =====================
  recordOut(r: DailySummaryRecord): RecordOut {
    const out: any = { regionId: r.regionId, regionName: r.regionName, fertilizerType: r.fertilizerType };
    for (const k of NUM_KEYS) out[k] = (r as any)[NUM_FIELDS[k]];
    return out;
  }

  totals(records: RecordOut[]) {
    const t: Record<string, number> = Object.fromEntries(NUM_KEYS.map(k => [k, 0]));
    t.annualPlanMT = 0;
    for (const r of records) {
      for (const k of NUM_KEYS) t[k] += r[k] || 0;
      t.annualPlanMT += (r.procuredMT || 0) + (r.regionalStockMT || 0);
    }
    const pct = (v: number) => (t.annualPlanMT > 0 ? ((v / t.annualPlanMT) * 100).toFixed(2) : '0.00');
    return {
      ...t, dispatchPerf: pct(t.dispatchedMT), portPerf: pct(t.portCumulativeMT), hubPerf: pct(t.hubCumulativeMT),
      stockCoverage: t.annualPlanMT > 0 ? ((t.currentRegionStockMT / t.annualPlanMT) * 100).toFixed(1) : '0'
    };
  }

  // ===================== Data scope =====================
  /**
   * Report regions the user may read: all for national roles; for regional officers the report regions mapped to
   * their own region (report_regions.admin_unit_id). Unmapped report regions are national-only.
   */
  private async readableRegions(user: AuthUser): Promise<Set<string> | null> {
    if (isNational(user)) return null;
    const rows = await this.reportRegions.find();
    return new Set(visibleRows(user, rows, rr => (rr.adminUnitId ? { regionId: rr.adminUnitId } : null)).map(rr => rr.id));
  }

  private async assertRegion(user: AuthUser, regionId: string): Promise<void> {
    const readable = await this.readableRegions(user);
    if (readable && !readable.has(regionId)) throw Errors.outOfScope('region');
  }

  async datesOut() {
    const rows = await this.dates.find({ order: { sort: 'ASC' } });
    return rows.map((d, i) => ({ id: d.id, label: d.label, isLatest: i === rows.length - 1 }));
  }

  async recordsFor(date: string | undefined, user?: AuthUser) {
    if (!date) return [];
    const readable = user ? await this.readableRegions(user) : null;
    return (await this.records.find({ where: { dateId: date }, order: { sort: 'ASC' } }))
      .filter(r => !readable || readable.has(r.regionId))
      .map(r => this.recordOut(r));
  }

  async all(user: AuthUser) {
    const dates = await this.datesOut();
    const recordsByDate: Record<string, RecordOut[]> = {};
    for (const d of dates) {
      const recs = await this.recordsFor(d.id, user);
      if (recs.length) recordsByDate[d.id] = recs;
    }
    return { dates, recordsByDate };
  }

  async summary(q: DailySummaryQuery, user: AuthUser) {
    const dates = await this.datesOut();
    const date = q.date || dates[dates.length - 1]?.id;
    if (!date || !(await this.dates.exist({ where: { id: date } }))) throw Errors.notFound('Report date');
    if (q.regionId && q.regionId !== 'ALL') await this.assertRegion(user, q.regionId);
    let records = await this.recordsFor(date, user);
    if (q.regionId && q.regionId !== 'ALL') records = records.filter(r => r.regionId === q.regionId);
    if (q.fertilizerType && q.fertilizerType !== 'ALL') records = records.filter(r => r.fertilizerType === q.fertilizerType);
    if (q.q) {
      const s = String(q.q).toLowerCase();
      records = records.filter(r => r.regionName.toLowerCase().includes(s) || r.fertilizerType.toLowerCase().includes(s));
    }
    const byRegion: Record<string, { regionId: string; regionName: string; items: RecordOut[] }> = {};
    for (const r of records) (byRegion[r.regionId] ||= { regionId: r.regionId, regionName: r.regionName, items: [] }).items.push(r);
    return { date, records, grandTotals: this.totals(records), regionGroups: Object.values(byRegion).map(g => ({ ...g, totals: this.totals(g.items) })) };
  }

  async updateRecord(user: AuthUser, date: string, regionId: string, fertilizerType: string, dto: UpdateDailyRecordDto, ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const repo = m.getRepository(DailySummaryRecord);
      const where = { dateId: date, regionId, fertilizerType };
      const old = await repo.findOneBy(where);
      if (!old) throw Errors.notFound('Report record');
      const set: Record<string, number> = {};
      const changed: Record<string, number> = {};
      for (const k of NUM_KEYS) {
        if (dto[k] !== undefined) {
          set[NUM_FIELDS[k]] = dto[k]!;
          changed[k] = dto[k]!;
        }
      }
      if (!Object.keys(set).length) throw Errors.badRequest('No fields to update');
      await repo.update(where, { ...set, updatedBy: user.name, updatedAt: new Date() });
      const updated = this.recordOut((await repo.findOneBy(where))!);
      await this.audit.record(user, 'DAILY_REPORT_RECORD_UPDATED', `${date}/${regionId}/${fertilizerType}`, { old: this.recordOut(old), new: changed }, ctx, m);
      return { ...updated, message: `Record updated for ${updated.regionName} (${updated.fertilizerType})` };
    });
  }

  /** Open a new report date, carrying over the previous date's figures (daily port movement resets to 0). */
  async openDate(user: AuthUser, dto: CreateReportDateDto, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const dRepo = m.getRepository(DailySummaryDate);
      if (await dRepo.exist({ where: { id: dto.id } })) throw Errors.conflict('Report date already exists');
      const last = (await dRepo.find({ order: { sort: 'DESC' }, take: 1 }))[0];
      await dRepo.insert({ id: dto.id, label: dto.label || dto.id, sort: (last?.sort ?? -1) + 1 });
      if (last) {
        const rRepo = m.getRepository(DailySummaryRecord);
        const prev = await rRepo.find({ where: { dateId: last.id }, order: { sort: 'ASC' } });
        const now = new Date();
        if (prev.length) {
          await rRepo.insert(prev.map(p => ({ ...p, dateId: dto.id, portDailyMt: 0, updatedBy: user.name, updatedAt: now })));
        }
      }
      await this.audit.record(user, 'DAILY_REPORT_DATE_OPENED', dto.id, { carriedFrom: last?.id }, ctx, m);
    });
    return { dates: await this.datesOut(), records: await this.recordsFor(dto.id) };
  }

  async exportCsv(user: AuthUser, date: string | undefined, ctx: RequestContext) {
    const d = date || (await this.datesOut()).slice(-1)[0]?.id;
    const recs = await this.recordsFor(d, user);
    await this.audit.record(user, 'DATA_EXPORT', `DAILY_SUMMARY/${d}`, { rows: recs.length }, ctx);
    const header = ['ክልል (Region)', 'የማዳበሪያ ዓይነት (Type)', 'ከውጭ የተገዛ (Procured MT)', 'በክልል ደረጃ (Regional Stock MT)', 'የዓመቱ ዕቅድ (Annual Plan MT)', 'የተላከ (Dispatched MT)', 'አፈፃፀም % (Dispatch)',
      'ከወደብ የገባ እስከ ቀኑ (Port Cumulative MT)', 'ከወደብ የገባ በዚህ ቀን (Port Daily MT)', 'አፈፃፀም % (Port)', 'በክልሉ ያለ ማዳበሪያ (Region Stock MT)', 'ከወደብ የደረሰ (Delivered MT)', 'ወረፋ/ልዩነት (Queue MT)', 'ወደ ማዕከል በዚህ ሳምንት (Hub Week MT)', 'ወደ ማዕከል እስከዚህ ሳምንት (Hub Cumulative MT)'];
    const rows = recs.map(r => {
      const plan = r.procuredMT + r.regionalStockMT;
      return [r.regionName, r.fertilizerType, r.procuredMT, r.regionalStockMT, plan, r.dispatchedMT, plan ? ((r.dispatchedMT / plan) * 100).toFixed(2) : '0.00',
        r.portCumulativeMT, r.portDailyMT, plan ? ((r.portCumulativeMT / plan) * 100).toFixed(2) : '0.00', r.currentRegionStockMT, r.deliveredToRegionMT, r.queueMT,
        r.hubThisWeekMT, r.hubCumulativeMT];
    });
    return { filename: `Daily_Fertilizer_Summary_${d}.csv`, csv: toCsv(header, rows) };
  }

  // ===================== Regional Vessel Dispatch & Union Loading =====================
  private async lotsOut(lots: VesselLot[]) {
    if (!lots.length) return [];
    const unions = await this.unions.find({ where: { lotId: In(lots.map(l => l.lotId)) }, order: { sort: 'ASC' } });
    const loads = unions.length ? await this.loads.find({ where: { unionId: In(unions.map(u => u.id)) } }) : [];
    return lots.map(l => {
      const us = unions.filter(u => u.lotId === l.lotId).map(u => ({
        id: unionShortId(u.id), unionName: u.unionName, destination: u.destination, shareMT: u.shareMt,
        dailyLoadedMT: Object.fromEntries(loads.filter(d => d.unionId === u.id).map(d => [d.date, d.mt])) as Record<string, number>
      }));
      const shareTotal = us.reduce((s, u) => s + u.shareMT, 0);
      const loadedTotal = us.reduce((s, u) => s + Object.values(u.dailyLoadedMT).reduce((a, b) => a + b, 0), 0);
      return {
        lotId: l.lotId, vesselName: l.vesselName, fertilizerType: l.fertilizerType, status: l.status, lotCode: l.lotCode, dateColumns: l.dateColumns || [], unions: us,
        totals: { shareMT: shareTotal, loadedMT: round(loadedTotal), remainingMT: round(shareTotal - loadedTotal), progressPct: shareTotal ? round((loadedTotal / shareTotal) * 100, 1) : 0 }
      };
    });
  }

  async lotOut(lotId: string) {
    return (await this.lotsOut([await this.getLot(lotId)]))[0];
  }

  private async getLot(lotId: string, repo: Repository<VesselLot> = this.lots) {
    const l = await repo.findOneBy({ lotId });
    if (!l) throw Errors.notFound('Vessel lot');
    return l;
  }

  async regions(user: AuthUser) {
    const readable = await this.readableRegions(user);
    return (await this.reportRegions.find({ order: { sort: 'ASC' } }))
      .filter(r => !readable || readable.has(r.id))
      .map(r => ({ id: r.id, name: r.name, amharic: r.amharic, color: r.color }));
  }

  /** { regionId: [lots] } or the lots of one region */
  async listLots(user: AuthUser, regionId?: string) {
    if (regionId) {
      await this.assertRegion(user, regionId);
      return this.lotsOut(await this.lots.find({ where: { regionId }, order: { sort: 'ASC' } }));
    }
    const readable = await this.readableRegions(user);
    const all = (await this.lots.find({ order: { regionId: 'ASC', sort: 'ASC' } })).filter(l => !readable || readable.has(l.regionId));
    const outs = await this.lotsOut(all);
    const out: Record<string, any[]> = {};
    all.forEach((l, i) => (out[l.regionId] ||= []).push(outs[i]));
    return out;
  }

  async createLot(user: AuthUser, dto: CreateLotDto, ctx: RequestContext) {
    const lotId = await this.ds.transaction(async m => {
      if (!(await m.getRepository(ReportRegion).exist({ where: { id: dto.regionId } }))) throw Errors.notFound('Report region');
      const repo = m.getRepository(VesselLot);
      const n = await repo.countBy({ regionId: dto.regionId });
      const id = `LOT-${dto.regionId.toUpperCase().slice(0, 4)}-${Date.now().toString(36).toUpperCase()}`;
      const status = dto.status || 'Active Loading';
      await repo.insert({ lotId: id, regionId: dto.regionId, vesselName: dto.vesselName, fertilizerType: dto.fertilizerType, status, lotCode: dto.lotCode || null, dateColumns: [], sort: n });
      await this.audit.record(user, 'VESSEL_LOT_CREATED', id, { ...dto, status }, ctx, m);
      return id;
    });
    return this.lotOut(lotId);
  }

  private async addDateColumn(repo: Repository<VesselLot>, lot: VesselLot, date: string) {
    const cols = lot.dateColumns || [];
    if (!cols.includes(date)) await repo.update({ lotId: lot.lotId }, { dateColumns: [...cols, date] });
  }

  /** Inline cell edit: set the loaded quantity for a union on a date. */
  async setUnionLoad(user: AuthUser, lotId: string, unionIdIn: string, dto: UnionLoadDto, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const lotRepo = m.getRepository(VesselLot);
      const lot = await this.getLot(lotId, lotRepo);
      const unionId = resolveUnionId(lot.lotId, unionIdIn);
      if (!(await m.getRepository(LotUnion).exist({ where: { id: unionId, lotId: lot.lotId } }))) throw Errors.notFound('Union');
      const loadRepo = m.getRepository(UnionDailyLoad);
      const old = await loadRepo.findOneBy({ unionId, date: dto.date });
      await loadRepo.save({ unionId, date: dto.date, mt: dto.mt });
      await this.addDateColumn(lotRepo, lot, dto.date);
      await this.audit.record(user, 'UNION_LOAD_EDITED', unionId, { date: dto.date, old: old?.mt ?? 0, new: dto.mt }, ctx, m);
    });
    return this.lotOut(lotId);
  }

  /** Add Dispatch Loading Entry: adds to the day's total and records the waybill/truck. */
  async addDispatch(user: AuthUser, lotId: string, dto: DispatchEntryDto, ctx: RequestContext) {
    const { warning, unionName } = await this.ds.transaction(async m => {
      const lotRepo = m.getRepository(VesselLot);
      const lot = await this.getLot(lotId, lotRepo);
      const unionId = resolveUnionId(lot.lotId, dto.unionId);
      const union = await m.getRepository(LotUnion).findOneBy({ id: unionId, lotId: lot.lotId });
      if (!union) throw Errors.notFound('Union');
      const wbRepo = m.getRepository(DispatchWaybill);
      if (await wbRepo.exist({ where: { waybillNo: dto.waybillNo } })) throw Errors.conflict(`Waybill ${dto.waybillNo} already recorded`);
      const loadRepo = m.getRepository(UnionDailyLoad);
      const loaded = (await loadRepo.findBy({ unionId })).reduce((s, d) => s + d.mt, 0);
      const warn = loaded + dto.mtLoaded > union.shareMt
        ? `Loading exceeds ${union.unionName} share (${union.shareMt} MT) by ${round(loaded + dto.mtLoaded - union.shareMt)} MT` : null;
      const day = await loadRepo.findOneBy({ unionId, date: dto.date });
      await loadRepo.save({ unionId, date: dto.date, mt: (day?.mt ?? 0) + dto.mtLoaded });
      await this.addDateColumn(lotRepo, lot, dto.date);
      await wbRepo.insert({
        lotId: lot.lotId, unionId, date: dto.date, mt: dto.mtLoaded, waybillNo: dto.waybillNo, truckPlate: dto.truckPlate || null,
        driverName: dto.driverName || null, createdBy: user.name
      });
      await this.audit.record(user, 'DISPATCH_LOGGED', dto.waybillNo, { lotId: lot.lotId, union: union.unionName, mt: dto.mtLoaded, date: dto.date }, ctx, m);
      return { warning: warn, unionName: union.unionName };
    }).catch(err => {
      if (err?.code === '23505') throw Errors.conflict(`Waybill ${dto.waybillNo} already recorded`);
      throw err;
    });
    return {
      lot: await this.lotOut(lotId), warning,
      message: `Dispatch logged: ${dto.mtLoaded} MT loaded for ${unionName}. Waybill: ${dto.waybillNo}`
    };
  }

  async dispatches(user: AuthUser, lotId: string) {
    const lot = await this.getLot(lotId);
    await this.assertRegion(user, lot.regionId);
    const rows = await this.waybills.find({ where: { lotId: lot.lotId }, order: { id: 'DESC' } });
    const unions = await this.unions.find({ where: { lotId: lot.lotId } });
    const names = new Map(unions.map(u => [u.id, u.unionName]));
    return rows.filter(d => names.has(d.unionId)).map(d => ({
      waybillNo: d.waybillNo, union: names.get(d.unionId), unionId: unionShortId(d.unionId), date: d.date, mt: d.mt, truckPlate: d.truckPlate,
      driverName: d.driverName, recordedBy: d.createdBy, recordedAt: stamp(d.createdAt)
    }));
  }

  async addDate(user: AuthUser, lotId: string, dto: LotDateDto, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const lotRepo = m.getRepository(VesselLot);
      const lot = await this.getLot(lotId, lotRepo);
      const cols = lot.dateColumns || [];
      if (cols.includes(dto.date)) throw Errors.conflict(`Date column ${dto.date} already exists`);
      await lotRepo.update({ lotId: lot.lotId }, { dateColumns: [...cols, dto.date] });
      await this.audit.record(user, 'LOT_DATE_COLUMN_ADDED', lot.lotId, { date: dto.date }, ctx, m);
    });
    return { lot: await this.lotOut(lotId), message: `Added loading date column: ${dto.date}` };
  }

  async addUnion(user: AuthUser, lotId: string, dto: AddLotUnionDto, ctx: RequestContext) {
    const name = dto.unionName.toUpperCase();
    await this.ds.transaction(async m => {
      const lot = await this.getLot(lotId, m.getRepository(VesselLot));
      const repo = m.getRepository(LotUnion);
      const short = `u-${Date.now()}`;
      const n = await repo.countBy({ lotId: lot.lotId });
      await repo.insert({ id: `${lot.lotId}:${short}`, lotId: lot.lotId, unionName: name, destination: (dto.destination || 'REGIONAL STORE').toUpperCase(), shareMt: dto.shareMT ?? 0, sort: n });
      await this.audit.record(user, 'LOT_UNION_ADDED', lot.lotId, { ...dto, shareMT: dto.shareMT ?? 0 }, ctx, m);
    });
    return { lot: await this.lotOut(lotId), message: `Added union quota for ${name}` };
  }

  async regionalExport(user: AuthUser, regionId: string | undefined, ctx: RequestContext) {
    if (!regionId) throw Errors.badRequest('regionId is required');
    await this.assertRegion(user, regionId);
    const lots = await this.lotsOut(await this.lots.find({ where: { regionId }, order: { sort: 'ASC' } }));
    const rows: unknown[][] = [];
    for (const l of lots) {
      rows.push([`${l.vesselName} (${l.lotCode || l.lotId})`, l.fertilizerType, '', '', ...l.dateColumns]);
      for (const u of l.unions) {
        const total = Object.values(u.dailyLoadedMT).reduce((a, b) => a + b, 0);
        rows.push([u.unionName, u.destination, u.shareMT, round(total), ...l.dateColumns.map(d => u.dailyLoadedMT[d] ?? 0), round(u.shareMT - total)]);
      }
    }
    await this.audit.record(user, 'DATA_EXPORT', `REGIONAL_DISPATCH/${regionId}`, { lots: lots.length }, ctx);
    return { filename: `Regional_Dispatch_${regionId}.csv`, csv: toCsv(['Union / Lot', 'Destination / Type', 'Share (MT)', 'Loaded (MT)', 'Daily loads… / Remaining'], rows) };
  }
}
