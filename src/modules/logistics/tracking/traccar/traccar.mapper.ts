// Traccar → NormalizedPosition mapping. Provider-specific JSON is handled ONLY here (Logistics doc §14).
import { NormalizedPosition } from '../tracking.types';

/** Subset of Traccar's Position model (https://www.traccar.org/api-reference/#tag/Positions). Speed is in KNOTS. */
export interface TraccarPosition {
  id?: number | string;
  deviceId?: number | string;
  protocol?: string;
  serverTime?: string;
  deviceTime?: string;
  fixTime?: string;
  outdated?: boolean;
  valid?: boolean;
  latitude?: number | string;
  longitude?: number | string;
  altitude?: number;
  speed?: number | string;
  course?: number | string;
  accuracy?: number;
  attributes?: Record<string, unknown>;
}

/** Subset of Traccar's Device model. uniqueId is the IMEI / identifier configured on the tracker. */
export interface TraccarDevice {
  id?: number | string;
  uniqueId?: string;
  name?: string;
  status?: string;
  lastUpdate?: string;
}

/** Traccar event (event forwarding) */
export interface TraccarEvent {
  id?: number | string;
  type?: string;
  eventTime?: string;
  deviceId?: number | string;
  positionId?: number | string;
  attributes?: Record<string, unknown>;
}

export const TRACCAR_PROVIDER = 'TRACCAR';
export const KNOTS_TO_KMH = 1.852;

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** Attributes kept on the location row (telemetry useful for diagnostics; nothing secret). */
const KEPT_ATTRIBUTES = ['ignition', 'motion', 'sat', 'hdop', 'odometer', 'totalDistance', 'distance', 'power', 'battery', 'batteryLevel', 'rssi', 'event', 'alarm', 'fuel', 'io239', 'io240'];

export class TraccarMapper {
  static knotsToKmh(knots: unknown): number | null {
    const k = num(knots);
    return Number.isFinite(k) && k >= 0 ? Math.round(k * KNOTS_TO_KMH * 100) / 100 : null;
  }

  /** providerDeviceId = device.uniqueId when available, else String(position.deviceId). */
  static providerDeviceId(position: TraccarPosition | null | undefined, device?: TraccarDevice | null): string | null {
    if (device?.uniqueId !== undefined && device.uniqueId !== null && String(device.uniqueId).trim() !== '') return String(device.uniqueId).trim();
    if (position?.deviceId !== undefined && position.deviceId !== null) return String(position.deviceId);
    if (device?.id !== undefined && device.id !== null) return String(device.id);
    return null;
  }

  /**
   * Map one Traccar position (+ optional device) to the internal model. Never throws: invalid values are passed through
   * as NaN / Invalid Date so TrackingService.ingest rejects and records them (INVALID_COORDINATES / INVALID_TIMESTAMP).
   */
  static toNormalized(position: TraccarPosition, device?: TraccarDevice | null): NormalizedPosition {
    const time = position.fixTime || position.deviceTime || position.serverTime;
    const attrs: Record<string, unknown> = {};
    for (const k of KEPT_ATTRIBUTES) if (position.attributes && k in position.attributes) attrs[k] = position.attributes[k];
    if (position.valid !== undefined) attrs.valid = position.valid;
    if (position.outdated !== undefined) attrs.outdated = position.outdated;
    if (position.altitude !== undefined) attrs.altitude = position.altitude;
    if (position.accuracy !== undefined) attrs.accuracy = position.accuracy;
    if (position.protocol) attrs.protocol = position.protocol;
    if (position.serverTime) attrs.serverTime = position.serverTime;
    const course = num(position.course);
    return {
      provider: TRACCAR_PROVIDER,
      providerDeviceId: TraccarMapper.providerDeviceId(position, device),
      // Forwarded positions are pushed before Traccar persists them, so they carry id 0: not an identity.
      providerPositionId: position.id !== undefined && position.id !== null && Number(position.id) !== 0 ? String(position.id) : null,
      latitude: num(position.latitude),
      longitude: num(position.longitude),
      speedKmh: TraccarMapper.knotsToKmh(position.speed),
      heading: Number.isFinite(course) ? course : null,
      recordedAt: time ? new Date(time) : new Date(NaN),
      attributes: Object.keys(attrs).length ? attrs : null
    };
  }

  /** Normalise the Traccar forward body: { position, device } | [{ position, device }] | position | position[] */
  static unwrapForward(body: unknown): Array<{ position: TraccarPosition; device: TraccarDevice | null }> {
    const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
    const out: Array<{ position: TraccarPosition; device: TraccarDevice | null }> = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (o.position && typeof o.position === 'object') out.push({ position: o.position as TraccarPosition, device: (o.device as TraccarDevice) ?? null });
      else if ('latitude' in o || 'longitude' in o) out.push({ position: o as TraccarPosition, device: null });
    }
    return out;
  }

  /** Traccar event type → internal TrackingEvent type (null = ignored). */
  static eventType(type: string | undefined): 'DEVICE_OFFLINE' | 'DEVICE_ONLINE' | 'DEVICE_STALE' | null {
    switch (type) {
      case 'deviceOffline': return 'DEVICE_OFFLINE';
      case 'deviceOnline': return 'DEVICE_ONLINE';
      case 'deviceUnknown': return 'DEVICE_STALE';
      default: return null;
    }
  }
}
