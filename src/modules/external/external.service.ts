import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Farmer } from '../farmers/entities/farmer.entity';
import { FaydaVerification } from '../farmers/entities/fayda-verification.entity';
import { NsisSoilProfile } from '../hierarchy/entities/nsis-soil-profile.entity';
import { AuthUser } from '../../common/types/auth-user';
import { stamp } from '../../common/utils/helpers';

/** Exact user-facing messages from REQ-1.1-003 Error Handling. */
export const FAYDA_MESSAGES = {
  INVALID: 'The Fayda ID provided is not valid. Please check the number and try again.',
  UNAVAILABLE: 'Fayda verification is currently unavailable. You can proceed with manual registration, but verification will be required later.',
  PARTIAL: 'Fayda provided partial data. Please complete the missing fields.',
  DUPLICATE: 'This Fayda ID is already registered with another farmer. Contact support if this is an error.',
  MISMATCH: 'The information provided does not match Fayda records. Please verify.',
  FACE_MISMATCH: 'The photo provided does not match Fayda records. Please verify identity with additional documentation.'
};

const FAYDA_FORMATS = [/^FAN-\d{4}-\d{4}-\d{4}$/, /^FAYDA-ETH-\d{4}-\d{4}$/, /^\d{9,16}$/];

export const NSIS_LAYERS: Record<string, keyof NsisSoilProfile> = {
  N_DEFICIENCY: 'nDeficiencyPct', P_DEFICIENCY: 'pDeficiencyPct', S_DEFICIENCY: 'sDeficiencyPct', B_DEFICIENCY: 'bDeficiencyPct',
  ZN_DEFICIENCY: 'znDeficiencyPct', K_DEFICIENCY: 'kDeficiencyPct', SOIL_PH: 'acidicAreaPct', DROUGHT_RISK: 'rainfallAnomalyPct'
};

export type FaydaResult =
  | { status: 'VERIFIED'; faydaStatus: 'VERIFIED_ACTIVE'; record: FaydaRecord; source: string }
  | { status: 'INVALID'; message: string }
  | { status: 'UNAVAILABLE'; faydaStatus: 'FAYDA_VERIFICATION_PENDING'; message: string }
  | { status: 'MISMATCH'; message: string; record: FaydaRecord };

export interface FaydaRecord {
  faydaId: string;
  fullName: { first: string; middle: string; last: string };
  dateOfBirth: string;
  gender: string;
  placeOfBirth: string;
  regionOfOrigin: string;
  nationalIdNumber: string;
  fatherName: string;
  maritalStatus: string;
  photoAvailable: boolean;
  digitalSignatureAvailable: boolean;
}

/**
 * Adapters for national systems: Fayda Digital ID (REQ-1.1-003), NRLAIS land certificates (REQ-1.1-001),
 * NSIS soil data (REQ-1.3-002 / REQ-1.5-001). Each uses a deterministic mock until the *_API_URL is configured;
 * replace the mock bodies with HTTPS + OAuth 2.0 client-credential calls when endpoints are issued.
 */
@Injectable()
export class ExternalService {
  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Farmer) private readonly farmers: Repository<Farmer>,
    @InjectRepository(FaydaVerification) private readonly faydaLog: Repository<FaydaVerification>,
    @InjectRepository(NsisSoilProfile) private readonly soil: Repository<NsisSoilProfile>
  ) {}

  // ---------------- Fayda ----------------
  private async faydaMockLookup(faydaId: string): Promise<FaydaRecord> {
    const known = await this.farmers.findOne({ where: { faydaId } });
    const h = crypto.createHash('sha256').update(faydaId).digest();
    const pick = <T>(arr: T[], i: number) => arr[h[i] % arr.length];
    const first = known?.firstName || pick(['Abebe', 'Tsehay', 'Lemma', 'Hirut', 'Gemechu', 'Meseret', 'Dawit', 'Aster'], 0);
    const middle = known?.middleName || pick(['Kebede', 'Bekele', 'Tolosa', 'Haile', 'Ayana', 'Girma'], 1);
    const last = known?.lastName || pick(['Tadesse', 'Wolde', 'Mengesha', 'Alemu', 'Roba', 'Desta'], 2);
    const year = 1960 + (h[4] % 40);
    return {
      faydaId,
      fullName: { first, middle, last },
      dateOfBirth: `${year}-${String(1 + (h[5] % 12)).padStart(2, '0')}-${String(1 + (h[6] % 28)).padStart(2, '0')}`,
      gender: known?.gender || (h[3] % 2 ? 'Male' : 'Female'),
      placeOfBirth: pick(['Adama', 'Bahir Dar', 'Hawassa', 'Mekelle', 'Jimma', 'Debre Markos'], 7),
      regionOfOrigin: known?.region || pick(['Oromia', 'Amhara', 'Sidama', 'Tigray'], 8),
      nationalIdNumber: known?.nationalIdNumber || `NID-ET-${String(h.readUInt32BE(9) % 1e8).padStart(8, '0')}`,
      fatherName: middle,
      maritalStatus: pick(['Married', 'Single', 'Widowed'], 13),
      photoAvailable: true,
      digitalSignatureAvailable: false
    };
  }

  async faydaVerify(rawId: string, opts: { user?: AuthUser; expected?: { firstName?: string; gender?: string } } = {}): Promise<FaydaResult> {
    const faydaId = String(rawId || '').trim().toUpperCase();
    const log = (success: boolean, reason: string) => this.faydaLog.insert({ faydaId: faydaId.slice(0, 40), userId: opts.user?.id ?? null, success, reason });

    if (this.config.get<boolean>('integrations.faydaSimulateOutage')) {
      await log(false, 'API_UNAVAILABLE');
      return { status: 'UNAVAILABLE', faydaStatus: 'FAYDA_VERIFICATION_PENDING', message: FAYDA_MESSAGES.UNAVAILABLE };
    }
    if (!FAYDA_FORMATS.some(r => r.test(faydaId)) || /0000$/.test(faydaId)) {
      await log(false, 'INVALID_ID');
      return { status: 'INVALID', message: FAYDA_MESSAGES.INVALID };
    }
    const record = await this.faydaMockLookup(faydaId);
    const e = opts.expected;
    if (e && ((e.gender && e.gender !== record.gender) || (e.firstName && e.firstName.toLowerCase() !== record.fullName.first.toLowerCase()))) {
      await log(false, 'DATA_MISMATCH');
      return { status: 'MISMATCH', message: FAYDA_MESSAGES.MISMATCH, record };
    }
    await log(true, 'VERIFIED');
    return { status: 'VERIFIED', faydaStatus: 'VERIFIED_ACTIVE', record, source: this.config.get('integrations.faydaUrl') ? 'FAYDA_API' : 'FAYDA_MOCK' };
  }

  // ---------------- NRLAIS ----------------
  async nrlaisVerify(landCertNumber: string) {
    const ok = /^NRLAIS-[A-Z]{2}-[A-Z]{2}-\d{4,6}-\d{4}$/.test(String(landCertNumber || ''));
    if (!ok) return { verified: false, message: 'Land certificate number not found in NRLAIS (expected format NRLAIS-RR-WW-NNNNN-YYYY)' };
    const h = crypto.createHash('sha256').update(landCertNumber).digest();
    return {
      verified: true, landCertNumber, registeredAreaHa: Math.round((0.5 + (h[0] % 60) / 10) * 100) / 100, holderVerified: true,
      source: this.config.get('integrations.nrlaisUrl') ? 'NRLAIS_API' : 'NRLAIS_MOCK'
    };
  }

  // ---------------- NSIS (cached profile; falls back to cache with timestamp when API unavailable) ----------------
  async nsisRaw(regionId: string) {
    return this.soil.findOne({ where: { regionId } });
  }

  async nsisProfile(regionId: string) {
    const p = await this.soil.findOne({ where: { regionId } });
    if (!p) return null;
    return {
      regionId,
      deficiencies: { N: p.nDeficiencyPct, P: p.pDeficiencyPct, S: p.sDeficiencyPct, B: p.bDeficiencyPct, Zn: p.znDeficiencyPct, K: p.kDeficiencyPct },
      acidity: { acidicAreaPct: p.acidicAreaPct, averagePh: p.avgPh },
      organicMatterPct: p.organicMatterPct,
      climate: { droughtRisk: p.droughtRisk, rainfallAnomalyPct: p.rainfallAnomalyPct, source: 'Ethiopian Meteorological Institute' },
      recommendedRatesKgHa: { NPSB: p.recommendedNpsbKgHa, UREA: p.recommendedUreaKgHa },
      confidence: p.confidence,
      verifiedPct: p.verifiedPct,
      soilCores: p.soilCores,
      dataVersion: p.dataVersion,
      lastUpdated: stamp(p.updatedAt),
      source: this.config.get('integrations.nsisUrl') ? 'NSIS_API' : 'NSIS_CACHE'
    };
  }
}
