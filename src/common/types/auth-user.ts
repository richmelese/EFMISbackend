/** The authenticated principal attached to request.user by the JWT strategy. */
export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /**
   * Base (system) role: drives DATA SCOPE (administrative area, own trips, own warehouse). For a custom role this is
   * the system role it is based on; `roleId` is the assigned role whose permissions apply.
   */
  role: string;
  /** Assigned role (system or custom) */
  roleId?: string;
  roleName?: string | null;
  /** Permission keys granted to roleId (from role_permissions, resolved per request with a short cache) */
  permissions?: string[];
  /** Must change the temporary password before using anything else */
  mustChangePassword?: boolean;
  title: string | null;
  regionId: string | null;
  zoneId: string | null;
  woredaId: string | null;
  kebeleId: string | null;
  /** Logistics: warehouse scope for WAREHOUSE_OPERATOR */
  warehouseId?: string | null;
  preferredLanguage: string;
  /** JWT id (session id) */
  jti?: string;
  /** JWT expiry (epoch seconds) */
  tokenExp?: number;
}

/** Request context passed to services for auditing. */
export interface RequestContext {
  ip?: string;
  source?: string;
  sessionId?: string;
}
