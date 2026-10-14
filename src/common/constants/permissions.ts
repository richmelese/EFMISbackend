// Role-Based Access Control matrix (REQ-1.7-001, roles from REQ-1.6-001).
// Role IDs match the frontend role switcher (DA, KEBELE, WOREDA, ZONE, REGION, MOA, FTWG, EABC, PMO),
// plus ATI (demand-document co-signatory), ECAE (quality lab), ADMIN and AUDITOR (REQ-1.7-001).

export enum Role {
  DA = 'DA',
  KEBELE = 'KEBELE',
  WOREDA = 'WOREDA',
  ZONE = 'ZONE',
  REGION = 'REGION',
  MOA = 'MOA',
  FTWG = 'FTWG',
  ATI = 'ATI',
  EABC = 'EABC',
  PMO = 'PMO',
  ECAE = 'ECAE',
  ADMIN = 'ADMIN',
  AUDITOR = 'AUDITOR',
  // Logistics & Driver Management roles
  LOGISTICS_MANAGER = 'LOGISTICS_MANAGER',
  DISPATCHER = 'DISPATCHER',
  FLEET_MANAGER = 'FLEET_MANAGER',
  DRIVER = 'DRIVER',
  WAREHOUSE_OPERATOR = 'WAREHOUSE_OPERATOR'
}

/** Roles not restricted to one administrative area. */
export const NATIONAL_ROLES: string[] = [Role.MOA, Role.FTWG, Role.ATI, Role.PMO, Role.EABC, Role.ECAE, Role.ADMIN, Role.AUDITOR, Role.LOGISTICS_MANAGER, Role.DISPATCHER, Role.FLEET_MANAGER];

/** Logistics roles that see the whole fleet (DRIVER / WAREHOUSE_OPERATOR are scoped to own trips / own warehouse). */
export const FLEET_WIDE_ROLES: string[] = [Role.LOGISTICS_MANAGER, Role.DISPATCHER, Role.FLEET_MANAGER, Role.MOA, Role.PMO, Role.EABC, Role.ADMIN, Role.AUDITOR];

const FIELD = [Role.DA, Role.KEBELE, Role.WOREDA, Role.ZONE, Role.REGION];
const NATIONAL_VIEW = [Role.MOA, Role.FTWG, Role.ATI, Role.PMO, Role.ADMIN, Role.AUDITOR];
const LOG_OPS = [Role.LOGISTICS_MANAGER, Role.DISPATCHER, Role.FLEET_MANAGER];
const LOG_VIEW = [...LOG_OPS, Role.MOA, Role.PMO, Role.EABC, Role.ADMIN, Role.AUDITOR];

/**
 * Permission keys checked by the code, with the roles that receive each one BY DEFAULT. The live grants are in the
 * database (`role_permissions`, managed by administrators through /api/roles); RbacService applies these defaults only
 * when a permission is first added to the catalogue.
 */
export const PERMISSIONS = {
  // Farmer registry & demand capture (2.4.1)
  'farmers:read': [...FIELD, ...NATIONAL_VIEW],
  'farmers:create': [Role.DA, Role.ADMIN],
  'farmers:update': [Role.DA, Role.KEBELE, Role.ADMIN],
  'farmers:delete': [Role.DA, Role.ADMIN],
  'farmers:documents': [Role.DA, Role.KEBELE, Role.ADMIN],
  'fayda:verify': [Role.DA, Role.KEBELE, Role.ADMIN],
  // Kebele review (REQ-1.1-007)
  'kebele:review': [Role.KEBELE, Role.ADMIN],
  // Aggregation & drill-down (REQ-1.2-001/002, REQ-INT-006)
  'aggregation:read': [...FIELD, ...NATIONAL_VIEW, Role.EABC],
  // Woreda / Zone review (REQ-1.2-003/004)
  'woreda:review': [Role.WOREDA, Role.ADMIN],
  'zone:review': [Role.ZONE, Role.ADMIN],
  'review:comment': [...FIELD, Role.MOA, Role.FTWG, Role.ADMIN],
  // Region analysis & submission (REQ-1.2-005/007)
  'region:analyze': [Role.REGION, Role.ZONE, ...NATIONAL_VIEW],
  'region:submit': [Role.REGION, Role.ADMIN],
  // National validation (2.4.4)
  'national:read': [Role.REGION, Role.EABC, ...NATIONAL_VIEW],
  'national:edit': [Role.MOA, Role.ADMIN],
  'ftwg:participate': [Role.FTWG, Role.MOA, Role.ATI],
  'ftwg:vote': [Role.FTWG],
  'ftwg:manage': [Role.FTWG, Role.MOA, Role.ADMIN],
  'document:sign': [Role.FTWG, Role.ATI, Role.MOA],
  // Quota allocation (2.4.5)
  'quota:read': [...FIELD, ...NATIONAL_VIEW, Role.EABC],
  'quota:generate': [Role.MOA, Role.ADMIN],
  'quota:request': [Role.REGION],
  'quota:decide': [Role.MOA, Role.ADMIN],
  'quota:allocate': [Role.MOA, Role.REGION, Role.ZONE, Role.WOREDA, Role.KEBELE, Role.ADMIN],
  'quota:amend': [Role.MOA, Role.REGION, Role.ZONE, Role.WOREDA, Role.ADMIN],
  'quota:letter': [Role.MOA, Role.ADMIN],
  'quota:acknowledge': [Role.REGION, Role.ZONE, Role.WOREDA, Role.KEBELE],
  'po:transmit': [Role.MOA, Role.ADMIN],
  'po:acknowledge': [Role.EABC],
  // Integration dashboards (Section 3)
  'integrations:read': [Role.REGION, Role.EABC, Role.ECAE, ...NATIONAL_VIEW, ...LOG_OPS],
  'integrations:write': [Role.EABC, Role.ECAE, Role.ADMIN],
  'alerts:read': [...FIELD, ...NATIONAL_VIEW, Role.EABC, Role.ECAE, ...LOG_OPS],
  'alerts:manage': [Role.MOA, Role.PMO, Role.ADMIN, Role.LOGISTICS_MANAGER, Role.DISPATCHER],
  'alerts:create': [Role.MOA, Role.PMO, Role.ECAE, Role.EABC, Role.REGION, Role.ADMIN],
  'audit:read': [Role.MOA, Role.PMO, Role.AUDITOR, Role.ADMIN],
  // Daily operational reports
  'reports:read': [Role.REGION, Role.EABC, ...NATIONAL_VIEW],
  'reports:edit': [Role.MOA, Role.EABC, Role.ADMIN],
  // ---- Logistics & Driver Management (Logistics_and_Driver_Management_Full_Flow) ----
  'drivers:read': [...LOG_VIEW, Role.DRIVER],
  'drivers:manage': [Role.LOGISTICS_MANAGER, Role.ADMIN],
  'drivers:verify': [Role.LOGISTICS_MANAGER, Role.ADMIN],
  /** licence number, IMEI/SIM and identity documents (restricted data) */
  'drivers:sensitive': [Role.LOGISTICS_MANAGER, Role.ADMIN],
  'fleet:read': [...LOG_VIEW],
  'fleet:manage': [Role.FLEET_MANAGER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  'devices:manage': [Role.FLEET_MANAGER, Role.ADMIN],
  'tracking:read': [...LOG_VIEW, Role.DRIVER, Role.WAREHOUSE_OPERATOR],
  /** GPS simulator / manual position push (dev, pilot diagnostics) */
  'tracking:ingest': [Role.FLEET_MANAGER, Role.ADMIN],
  'shipments:read': [...LOG_VIEW, Role.DRIVER, Role.WAREHOUSE_OPERATOR, Role.REGION],
  'shipments:manage': [Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  'trips:dispatch': [Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  /** driver self-service on own trip: accept, pre-trip acknowledgement, incidents, arrival */
  'trips:driver': [Role.DRIVER, Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  'trips:loading': [Role.WAREHOUSE_OPERATOR, Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  'deliveries:confirm': [Role.WAREHOUSE_OPERATOR, Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  'warehouses:read': [...LOG_VIEW, Role.WAREHOUSE_OPERATOR, Role.REGION],
  'warehouses:manage': [Role.LOGISTICS_MANAGER, Role.ADMIN],
  'inventory:transact': [Role.WAREHOUSE_OPERATOR, Role.LOGISTICS_MANAGER, Role.ADMIN],
  /** quality decision on stock lots (hold / release / reject) */
  'inventory:qc': [Role.ECAE, Role.LOGISTICS_MANAGER, Role.ADMIN],
  /** QR custody scans at dispatch, checkpoints, handover and receipt */
  'shipments:scan': [Role.WAREHOUSE_OPERATOR, Role.DRIVER, Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.ADMIN],
  'incidents:read': [...LOG_VIEW, Role.WAREHOUSE_OPERATOR, Role.DRIVER],
  'incidents:report': [Role.DRIVER, Role.DISPATCHER, Role.LOGISTICS_MANAGER, Role.FLEET_MANAGER, Role.WAREHOUSE_OPERATOR, Role.ADMIN],
  'incidents:manage': [Role.LOGISTICS_MANAGER, Role.PMO, Role.ADMIN],
  'routes:manage': [Role.LOGISTICS_MANAGER, Role.DISPATCHER, Role.ADMIN],
  'geofences:manage': [Role.LOGISTICS_MANAGER, Role.DISPATCHER, Role.ADMIN],
  'logistics:reports': [...LOG_VIEW],
  'jobs:manage': [Role.ADMIN],

  // Administration
  'users:manage': [Role.ADMIN],
  'roles:manage': [Role.ADMIN],
  'settings:manage': [Role.MOA, Role.ADMIN]
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** Default grant (used to seed role_permissions for new permissions; not for authorisation). */
export function defaultGrant(role: string, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

/** Authorisation check against the user's permissions resolved from the database (RbacService). */
export function can(user: { permissions?: readonly string[] } | null | undefined, permission: Permission): boolean {
  return !!user?.permissions?.includes(permission);
}
