import { Errors } from './errors';

/** Allowed transitions: from-state -> list of to-states. */
export type TransitionMap = Record<string, readonly string[]>;

/** Throws 409 INVALID_TRANSITION when `to` is not reachable from `from`. */
export function assertTransition(entity: string, map: TransitionMap, from: string, to: string): void {
  if (!(map[from] || []).includes(to)) {
    throw Errors.conflict(`Invalid ${entity} status transition ${from} → ${to}`, { from, to, allowed: map[from] || [] });
  }
}

export const canTransition = (map: TransitionMap, from: string, to: string) => (map[from] || []).includes(to);

// ---- Logistics lifecycles (Logistics doc §5) ----

export const SHIPMENT_TRANSITIONS: TransitionMap = {
  DRAFT: ['PLANNED', 'CANCELLED', 'ON_HOLD'],
  PLANNED: ['ASSIGNED', 'CANCELLED', 'ON_HOLD', 'DRAFT'],
  ASSIGNED: ['READY_FOR_DISPATCH', 'PLANNED', 'CANCELLED', 'ON_HOLD'],
  READY_FOR_DISPATCH: ['IN_TRANSIT', 'ASSIGNED', 'CANCELLED', 'ON_HOLD'],
  IN_TRANSIT: ['ARRIVED', 'DELIVERY_FAILED', 'ON_HOLD'],
  ARRIVED: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERED: ['CLOSED'],
  DELIVERY_FAILED: ['IN_TRANSIT', 'ARRIVED', 'CLOSED', 'CANCELLED'],
  ON_HOLD: ['DRAFT', 'PLANNED', 'ASSIGNED', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'CANCELLED'],
  CANCELLED: [],
  CLOSED: []
};

export const TRIP_TRANSITIONS: TransitionMap = {
  PLANNED: ['DRIVER_ACCEPTED', 'VEHICLE_CHECKED', 'ABORTED'],
  DRIVER_ACCEPTED: ['VEHICLE_CHECKED', 'ABORTED'],
  VEHICLE_CHECKED: ['LOADING', 'ABORTED'],
  LOADING: ['READY', 'ABORTED'],
  READY: ['DISPATCHED', 'ABORTED'],
  DISPATCHED: ['IN_PROGRESS', 'ARRIVED', 'INCIDENT', 'RETURNING', 'ABORTED'],
  IN_PROGRESS: ['ARRIVED', 'INCIDENT', 'RETURNING', 'ABORTED'],
  INCIDENT: ['IN_PROGRESS', 'RETURNING', 'ABORTED', 'ARRIVED'],
  RETURNING: ['ARRIVED', 'ABORTED', 'COMPLETED'],
  ARRIVED: ['UNLOADING', 'COMPLETED'],
  UNLOADING: ['COMPLETED'],
  COMPLETED: [],
  ABORTED: []
};

/** Trip states during which the truck and driver are committed. */
export const ACTIVE_TRIP_STATES = ['PLANNED', 'DRIVER_ACCEPTED', 'VEHICLE_CHECKED', 'LOADING', 'READY', 'DISPATCHED', 'IN_PROGRESS', 'INCIDENT', 'RETURNING', 'ARRIVED', 'UNLOADING'];
/** Trip states during which the truck is physically moving / tracked. */
export const MOVING_TRIP_STATES = ['DISPATCHED', 'IN_PROGRESS', 'INCIDENT', 'RETURNING'];

export const DRIVER_AVAILABILITY = ['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'UNAVAILABLE', 'DOCUMENT_EXPIRED'] as const;
export const DRIVER_EMPLOYMENT = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ON_LEAVE'] as const;
export const TRUCK_OPERATIONAL = ['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE'] as const;
export const TRUCK_AVAILABILITY = ['AVAILABLE', 'RESERVED', 'ON_TRIP'] as const;
