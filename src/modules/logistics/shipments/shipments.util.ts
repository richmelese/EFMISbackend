import { FLEET_WIDE_ROLES, Role } from '../../../common/constants/permissions';
import { AuthUser } from '../../../common/types/auth-user';
import { parseStamp } from '../../../common/utils/helpers';

/** ISO 8601 output for logistics endpoints. */
export const iso = (d?: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

/** Audit timestamps are local "YYYY-MM-DD HH:mm:ss" strings → ISO. */
export const stampToIso = (s?: string | null): string | null => {
  if (!s) return null;
  const d = parseStamp(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

/** Quantity tolerance (MT) used for loaded / delivered comparisons. */
export const QTY_EPS = 0.001;

export const r3 = (n: unknown): number => Math.round((Number(n) || 0) * 1000) / 1000;

/** Advisory lock keys serialising human-number generation. */
export const SHIPMENT_NUMBER_LOCK = 7_301_001;
export const TRIP_NUMBER_LOCK = 7_301_002;

/** System actor used for GPS-driven transitions (audit). */
export const GPS_ACTOR = { id: null, name: 'GPS Tracking', role: 'SYSTEM' };

/** Trip states before the truck leaves the origin (assignment can still change). */
export const PRE_DISPATCH_TRIP_STATES = ['PLANNED', 'DRIVER_ACCEPTED', 'VEHICLE_CHECKED', 'LOADING', 'READY'];

/** Shipment states before cargo has left the origin. */
export const PRE_TRANSIT_SHIPMENT_STATES = ['DRAFT', 'PLANNED', 'ASSIGNED', 'READY_FOR_DISPATCH'];

/** Postgres unique violation → constraint name (or null when not a unique violation). */
export function uniqueViolation(e: any): string | null {
  const de = e?.driverError ?? e;
  if (de?.code !== '23505') return null;
  return String(de.constraint || de.detail || 'unique');
}

/** Visibility scope of the current user over shipments / trips. */
export type LogisticsScope =
  | { kind: 'ALL' }
  | { kind: 'DRIVER'; driverId: string | null }
  | { kind: 'WAREHOUSE'; warehouseId: string | null }
  | { kind: 'REGION'; regionId: string | null };

export const isFleetWide = (user: AuthUser) => FLEET_WIDE_ROLES.includes(user.role);
export const isDriver = (user: AuthUser) => user.role === Role.DRIVER;
export const isWarehouseOperator = (user: AuthUser) => user.role === Role.WAREHOUSE_OPERATOR;

/** Uploaded file (multer memory storage). */
export interface UploadedProof {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export const PROOF_MIME_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
