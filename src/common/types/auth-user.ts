import { Permission } from '../constants/permissions';

/**
 * Administrative/location scope fields (REQ-1.7-001 data segmentation): which region, zone, woreda or kebele a
 * principal or record belongs to. Shared shape for `AuthUser` and anywhere else a user's area must be assigned
 * or validated (e.g. `UsersService`'s create/update scope resolution).
 */
export interface AdministrativeScope {
  regionId: string | null;
  zoneId: string | null;
  woredaId: string | null;
  kebeleId: string | null;
  /** Logistics: warehouse scope for WAREHOUSE_OPERATOR */
  warehouseId?: string | null;
}

/**
 * The authenticated principal attached to `request.user` by the JWT strategy. Immutable: every mutation (login,
 * role change, token refresh) produces a new `AuthUser` via spread rather than patching this object in place.
 */
export interface AuthUser extends Readonly<AdministrativeScope> {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  /**
   * Base (system) role: drives DATA SCOPE (administrative area, own trips, own warehouse). For a custom role this is
   * the system role it is based on; `roleId` is the assigned role whose permissions apply.
   */
  readonly role: string;
  /** Assigned role (system or custom) */
  readonly roleId?: string;
  readonly roleName?: string | null;
  /** Permission keys granted to roleId (from role_permissions, resolved per request with a short cache) */
  readonly permissions?: readonly Permission[];
  /** Must change the temporary password before using anything else */
  readonly mustChangePassword?: boolean;
  readonly title: string | null;
  readonly preferredLanguage: string;
  /** JWT id (session id) */
  readonly jti?: string;
  /** JWT expiry (epoch seconds) */
  readonly tokenExp?: number;
}

/** Request context passed to services for auditing. */
export interface RequestContext {
  readonly ip?: string;
  readonly source?: string;
  readonly sessionId?: string;
}
