// Normalized internal position model (Logistics doc §14: "Other modules consume a normalized internal position model").
// Provider-specific mapping (Traccar JSON etc.) lives only in tracking/traccar/.

export type PositionSource = 'TRACCAR_WEBHOOK' | 'TRACCAR_POLL' | 'PARTNER_FEED' | 'SIMULATOR' | 'MANUAL';

export interface NormalizedPosition {
  /** Provider name + device id identify the GpsDevice … */
  provider?: string;
  providerDeviceId?: string | null;
  /** … or the truck directly (partner feed / simulator by fleet code) */
  truckId?: string | null;
  /** Provider's position id — idempotency key for duplicates */
  providerPositionId?: string | null;
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  heading?: number | null;
  /** Device fix time */
  recordedAt: Date;
  attributes?: Record<string, unknown> | null;
}

export type IngestStatus = 'ACCEPTED' | 'DUPLICATE' | 'OUT_OF_ORDER' | 'REJECTED';

export interface IngestResult {
  status: IngestStatus;
  reason?: string;
  truckId?: string;
  locationId?: string;
}

/**
 * Job payload published on QUEUES.TRACKING with job name TRACKING_POSITION_JOB after an accepted (in-order) position.
 * The tracking event processor (routing module) consumes it: geofences, milestones, route deviation, ETA, delays.
 */
export const TRACKING_POSITION_JOB = 'position';

export interface PositionProcessedEvent {
  truckId: string;
  deviceId: string | null;
  /** Active trip of the truck at ingestion time (DISPATCHED/IN_PROGRESS/INCIDENT/RETURNING/ARRIVED…), if any */
  tripId: string | null;
  locationId: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  heading: number | null;
  /** ISO string (job payloads are JSON) */
  recordedAt: string;
}
