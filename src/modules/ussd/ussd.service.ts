import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { UssdSession } from './entities/ussd-session.entity';
import { QuotaAllocation } from '../quota/entities/quota.entities';
import { Vessel } from '../integrations/entities/integration.entities';
import { InventoryBalance, Warehouse } from '../logistics/warehouses/entities/warehouse.entities';
import { round } from '../../common/utils/helpers';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';

const MENU = {
  en: 'Welcome to FDRE EFMIS Mobile Portal\n1. Check Union Quota\n2. Track Vessel/Shipment\n3. Store Stock\n4. Report Delay\n0. Main Menu',
  am: 'እንኳን ወደ ኢፌዲሪ EFMIS ሞባይል በደህና መጡ\n1. የዩኒየን/ማህበር ኮታ እይ\n2. የመርከብ/ጭነት መረጃ\n3. የመጋዘን ክምችት\n4. መዘግየት ሪፖርት አድርግ\n0. ዋና ማውጫ'
};

const fmt = (n: number) => n.toLocaleString('en-US');

/** *804# USSD menus for feature phones (REQ-1.4-008). Replies start with CON (continue) or END (session over). */
@Injectable()
export class UssdService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(UssdSession) private readonly sessions: Repository<UssdSession>,
    @InjectRepository(QuotaAllocation) private readonly allocations: Repository<QuotaAllocation>,
    @InjectRepository(Vessel) private readonly vessels: Repository<Vessel>,
    @InjectRepository(Warehouse) private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(InventoryBalance) private readonly balances: Repository<InventoryBalance>,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService
  ) {}

  /** First Primary Cooperative quota line (the cooperative the demo phone belongs to). */
  private async pcAllocation() {
    const a = await this.allocations.findOne({ where: { level: 'PC' }, order: { sort: 'ASC' } });
    if (!a) return null;
    const total = a.npsbMt + a.ureaMt + a.otherMt;
    return {
      nameEn: a.recipientName, totalMT: total, receivedMT: a.receivedMt,
      quintals: { npsb: Math.round(a.npsbMt * 10), urea: Math.round(a.ureaMt * 10) },
      deliveredPct: total ? round((a.receivedMt / total) * 100, 1) : 0
    };
  }

  async reply(steps: string[], phone: string | undefined, lang: string): Promise<string> {
    const am = lang === 'am';
    const back = am ? '\n0. ተመለስ' : '\n0. Back';
    const last = steps[steps.length - 1];
    if (!steps.length || last === '0' || last === '*804#' || last === '') return `CON ${MENU[am ? 'am' : 'en']}`;
    const first = steps[0];
    if (first === '1') {
      const a = await this.pcAllocation();
      if (a) {
        const pending = Math.round(Math.max(a.totalMT - a.receivedMT, 0) * 10);
        return `CON ${a.nameEn} Quota:\n- NPSB: ${fmt(a.quintals.npsb)} Qtl\n- Urea: ${fmt(a.quintals.urea)} Qtl\nDelivered: ${Math.round(a.deliveredPct)}%\nPending: ${fmt(pending)} Qtl${back}`;
      }
    }
    if (first === '2') {
      const v = await this.vessels.findOne({ where: {}, order: { etaDjibouti: 'ASC' } });
      return v ? `CON Active Vessel:\n${v.name} (${v.cargo})\nStatus: ${v.berthingStatus}\nETA Djibouti: ${v.etaDjibouti}${back}` : 'END No active vessels';
    }
    if (first === '3') {
      const w = (await this.warehouses.findOne({ where: { name: ILike('Nazret%') } })) || (await this.warehouses.findOne({ where: {}, order: { sort: 'ASC' } }));
      const a = await this.pcAllocation();
      const recQ = a ? Math.round(a.receivedMT * 10) : 0;
      let hub = '';
      if (w) {
        // Utilisation = Σ on-hand stock across products / design capacity (logistics inventory ledger balances)
        const r = await this.balances.createQueryBuilder('b').select('COALESCE(SUM(b.onHandQuantity), 0)', 'onHand')
          .where('b.warehouseId = :id', { id: w.id }).getRawOne<{ onHand: string }>();
        const util = w.capacityMt > 0 ? (Number(r?.onHand) || 0) / w.capacityMt : 0;
        hub = `\nHub ${w.name}: ${Math.round(util * 100)}% full`;
      }
      return `CON Store Inventory (${a ? a.nameEn : 'PC'}):\n- Received: ${fmt(recQ)} Qtl${hub}${back}`;
    }
    if (first === '4') {
      if (steps.length === 1) return am ? 'CON የመዘግየቱን ምክንያት ያስገቡ:' : 'CON Describe the delay (location & cause):';
      const desc = steps.slice(1).join(' ');
      const alert = await this.ds.transaction(async m => {
        const a = await this.alerts.raise({
          severity: 'MEDIUM_YELLOW', title: 'Delivery delay reported via USSD *804#', category: 'Logistics Delays', trigger: desc,
          affectedArea: `Reporter ${phone || 'unknown'}`, actionRequired: 'Woreda / union to verify and respond', sourceType: 'USSD', sourceId: phone || null
        }, m);
        await this.audit.record({ name: `USSD ${phone || ''}`.trim(), role: 'USSD' }, 'USSD_DELAY_REPORTED', a.id, { description: desc }, { source: 'USSD' }, m);
        return a;
      });
      return `END Delay report received. Ref: ${alert.id}. Thank you.`;
    }
    return `CON ${am ? `የተሳሳተ ምርጫ [${last}]።\n0. ዋና ማውጫ` : `Invalid option [${last}].\n0. Main Menu`}`;
  }

  /** Gateway mode: the full input history arrives on every request. */
  gateway(text: string | undefined, phone: string | undefined, lang: string) {
    const steps = String(text || '').split('*').filter(s => s !== '');
    return this.reply(steps, phone, lang);
  }

  /** Simulator mode: one entry per request, session state kept server-side. */
  async simulator(input: string, sessionId: string | undefined, phone: string | undefined, lang: string) {
    const sid = `sim:${sessionId || 'simulator'}`;
    const s = await this.sessions.findOneBy({ sessionId: sid });
    let prev: string[] = [];
    if (s && s.state !== 'MAIN') {
      try { prev = JSON.parse(s.state); } catch { prev = []; }
    }
    const value = String(input).trim();
    let steps: string[];
    if (value === '0' || value === '*804#' || value === '') steps = [];
    else if (prev.length === 1 && prev[0] === '4') steps = ['4', value]; // free-text delay description
    else steps = [value]; // menus 1-3 are leaf screens; a new key starts from the main menu
    const reply = await this.reply(steps, phone, lang);
    if (reply.startsWith('END')) await this.sessions.delete({ sessionId: sid });
    else await this.sessions.save({ sessionId: sid, phone: phone || null, state: steps.length ? JSON.stringify(steps) : 'MAIN' });
    return { screen: reply.replace(/^(CON|END) /, ''), sessionEnded: reply.startsWith('END') };
  }
}
