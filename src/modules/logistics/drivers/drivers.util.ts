import { nowStamp } from '../../../common/utils/helpers';
import { VehicleType } from '../fleet/entities/fleet.entities';
import { Driver, DriverAvailability, DriverDocument, DriverTripAssignment } from './entities/driver.entities';

/** Local calendar date "YYYY-MM-DD" (driver licence / document dates are calendar dates). */
export const ymd = (d: Date = new Date()): string => nowStamp(d).slice(0, 10);

/** Add days to a "YYYY-MM-DD" date. */
export const addDaysYmd = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Whole days from `from` to `to` (both "YYYY-MM-DD"); negative when `to` is in the past. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

export const iso = (d?: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** Licence number masking for callers without drivers:sensitive. */
export const maskLicence = (v: string | null | undefined): string | null => {
  if (!v) return null;
  return v.length <= 4 ? '****' : `****${v.slice(-4)}`;
};

/** Availability window types that block assignment (SHIFT is a positive window). */
export const BLOCKING_WINDOW_TYPES = ['LEAVE', 'UNAVAILABLE', 'TRAINING'];
/** Document types required for assignment */
export const REQUIRED_DOCUMENT_TYPES = ['LICENCE'];

/** A document counts as valid through `onDate` when VERIFIED and not expired by then. */
export const docValidThrough = (doc: DriverDocument, onDate: string): boolean =>
  doc.verificationStatus === 'VERIFIED' && (!doc.expiresAt || doc.expiresAt >= onDate);

/**
 * Resting availability when a driver is not committed to a trip: employment, licence and verification decide.
 * Used when an assignment is released (setAvailability('AVAILABLE')) or employment is restored.
 */
export function restingAvailability(d: Driver, hasValidLicenceDoc: boolean): 'AVAILABLE' | 'UNAVAILABLE' | 'DOCUMENT_EXPIRED' {
  if (d.employmentStatus !== 'ACTIVE') return 'UNAVAILABLE';
  if (!d.licenceExpiryDate || d.licenceExpiryDate < ymd()) return 'DOCUMENT_EXPIRED';
  if (d.verificationStatus !== 'VERIFIED') return 'UNAVAILABLE';
  if (!hasValidLicenceDoc) return 'DOCUMENT_EXPIRED';
  return 'AVAILABLE';
}

/** Document metadata for the API (never the storage key or the file contents). */
export function docToFrontend(x: DriverDocument, warningDays: number) {
  const today = ymd();
  const horizon = addDaysYmd(today, warningDays);
  return {
    id: x.id,
    driverId: x.driverId,
    documentType: x.documentType,
    fileName: x.fileName,
    mimeType: x.mimeType,
    sizeBytes: x.sizeBytes,
    issuedAt: x.issuedAt,
    expiresAt: x.expiresAt,
    verificationStatus: x.verificationStatus,
    verifiedBy: x.verifiedBy,
    verifiedAt: iso(x.verifiedAt),
    rejectionReason: x.rejectionReason,
    uploadedBy: x.uploadedBy,
    uploadedAt: iso(x.createdAt),
    expired: x.verificationStatus === 'EXPIRED' || (!!x.expiresAt && x.expiresAt < today),
    expiringSoon: !!x.expiresAt && x.expiresAt >= today && x.expiresAt <= horizon,
    daysRemaining: x.expiresAt ? daysBetween(today, x.expiresAt) : null,
    fileUrl: `/api/v1/driver-documents/${x.id}/file`
  };
}

export interface EligibilityData {
  docs: DriverDocument[];
  /** Availability windows of this driver (any range; filtered here) */
  windows: DriverAvailability[];
  /** ACTIVE assignments of this driver */
  activeAssignments: DriverTripAssignment[];
  /** undefined = no vehicle type requested; null = requested but unknown */
  vehicleType?: VehicleType | null;
}

export interface EligibilityCtx {
  from: Date;
  to: Date;
  excludeTripId?: string;
}

/**
 * Pure eligibility evaluation (Logistics doc §6 step 7). Returns the list of reasons why the driver cannot be
 * assigned for [from, to]; an empty list means eligible.
 */
export function evaluateEligibility(d: Driver, data: EligibilityData, ctx: EligibilityCtx): string[] {
  const reasons: string[] = [];
  const toDate = ymd(ctx.to);
  const today = ymd();

  if (d.employmentStatus !== 'ACTIVE') reasons.push(`Employment status is ${d.employmentStatus} (must be ACTIVE)`);
  if (d.verificationStatus !== 'VERIFIED') reasons.push(`Driver is not verified (verification status ${d.verificationStatus})`);

  if (!d.licenceExpiryDate || d.licenceExpiryDate < today) reasons.push(`Driving licence expired on ${d.licenceExpiryDate}`);
  else if (d.licenceExpiryDate < toDate) reasons.push(`Driving licence expires on ${d.licenceExpiryDate}, before the trip ends (${toDate})`);

  if (data.vehicleType === null) reasons.push('Vehicle type not found');
  else if (data.vehicleType) {
    const allowed = data.vehicleType.allowedLicenceClasses || [];
    if (allowed.length && !allowed.includes(d.licenceClass)) {
      reasons.push(`Licence class ${d.licenceClass} is not allowed for vehicle type ${data.vehicleType.code} (allowed: ${allowed.join(', ')})`);
    }
  }

  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const ofType = data.docs.filter(x => x.documentType === type);
    if (ofType.some(x => docValidThrough(x, toDate))) continue;
    const expired = ofType.some(x => x.verificationStatus === 'EXPIRED' || (x.expiresAt && x.expiresAt < toDate));
    reasons.push(expired ? `Required ${type} document expired or expires before the trip ends` : `No verified ${type} document on file`);
  }
  for (const c of d.certifications || []) {
    if (c?.expiresAt && c.expiresAt < toDate) reasons.push(`Certification "${c.name}" ${c.expiresAt < today ? 'expired' : 'expires'} on ${c.expiresAt}`);
  }

  const from = ctx.from.getTime();
  const to = ctx.to.getTime();
  for (const w of data.windows) {
    if (!BLOCKING_WINDOW_TYPES.includes(w.availabilityType)) continue;
    if (new Date(w.startAt).getTime() < to && new Date(w.endAt).getTime() > from) {
      reasons.push(`${w.availabilityType} window ${new Date(w.startAt).toISOString()} – ${new Date(w.endAt).toISOString()} overlaps the requested period`);
    }
  }

  const otherAssignments = data.activeAssignments.filter(a => a.tripId !== ctx.excludeTripId);
  if (otherAssignments.length) reasons.push(`Already has an active assignment on another trip (${otherAssignments.map(a => a.tripId).join(', ')})`);

  const onExcludedTrip = !!ctx.excludeTripId && data.activeAssignments.some(a => a.tripId === ctx.excludeTripId);
  if (d.availabilityStatus !== 'AVAILABLE' && !(onExcludedTrip && ['ASSIGNED', 'ON_TRIP'].includes(d.availabilityStatus))) {
    reasons.push(`Availability status is ${d.availabilityStatus} (must be AVAILABLE)`);
  }
  return [...new Set(reasons)];
}

/** Map a Postgres unique violation to a readable conflict message (null when not a unique violation). */
export function uniqueViolation(err: any): string | null {
  if (err?.code !== '23505') return null;
  const c = String(err?.constraint || err?.detail || '');
  if (/licence/i.test(c)) return 'Licence number is already registered to another driver';
  if (/employee/i.test(c)) return 'Employee number already exists';
  if (/sha256/i.test(c)) return 'Duplicate document upload detected (identical file already stored)';
  if (/user/i.test(c)) return 'This user account is already linked to another driver';
  if (/assignment/i.test(c)) return 'Driver already has an active assignment';
  return 'Duplicate value violates a unique constraint';
}
