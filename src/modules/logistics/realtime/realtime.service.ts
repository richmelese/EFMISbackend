import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Server } from 'socket.io';

/** WebSocket event contract (Logistics doc §16). */
export type RealtimeEventType =
  | 'truck.location.updated'
  | 'truck.device.status_changed'
  | 'driver.assignment.updated'
  | 'trip.status.updated'
  | 'shipment.status.updated'
  | 'shipment.eta.updated'
  | 'shipment.delayed'
  | 'geofence.entered'
  | 'geofence.exited'
  | 'route.deviation.detected'
  | 'alert.created'
  | 'delivery.confirmed';

export interface RealtimeEntities {
  truckId?: string | null;
  tripId?: string | null;
  shipmentIds?: string[];
  driverId?: string | null;
  /** Warehouses involved (origin/destination) — lets WAREHOUSE_OPERATOR sockets receive their events */
  warehouseIds?: string[];
  deviceId?: string | null;
  geofenceId?: string | null;
  alertId?: string | null;
}

export interface RealtimeEnvelope<T = unknown> {
  eventId: string;
  eventType: RealtimeEventType;
  occurredAt: string;
  payloadVersion: 1;
  entities: RealtimeEntities;
  payload: T;
}

/** Room naming. Fleet-wide roles join FLEET_ROOM; everyone else only gets entity rooms they are authorised for. */
export const FLEET_ROOM = 'fleet:all';
export const rooms = {
  truck: (id: string) => `truck:${id}`,
  trip: (id: string) => `trip:${id}`,
  shipment: (id: string) => `shipment:${id}`,
  driver: (id: string) => `driver:${id}`,
  warehouse: (id: string) => `warehouse:${id}`
};

/**
 * Publishes logistics events to authorised WebSocket rooms only (never broadcast to every client).
 * Works without a server attached (e.g. in scripts) — events are then dropped after logging at debug level.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger('Realtime');
  private server: Server | null = null;
  /** Recent events kept for tests/diagnostics */
  readonly recent: RealtimeEnvelope[] = [];

  attach(server: Server) {
    this.server = server;
  }

  publish<T>(eventType: RealtimeEventType, entities: RealtimeEntities, payload: T): RealtimeEnvelope<T> {
    const envelope: RealtimeEnvelope<T> = { eventId: randomUUID(), eventType, occurredAt: new Date().toISOString(), payloadVersion: 1, entities, payload };
    this.recent.push(envelope);
    if (this.recent.length > 200) this.recent.shift();
    if (!this.server) return envelope;
    const target = new Set<string>([FLEET_ROOM]);
    if (entities.truckId) target.add(rooms.truck(entities.truckId));
    if (entities.tripId) target.add(rooms.trip(entities.tripId));
    if (entities.driverId) target.add(rooms.driver(entities.driverId));
    for (const s of entities.shipmentIds || []) target.add(rooms.shipment(s));
    for (const w of entities.warehouseIds || []) target.add(rooms.warehouse(w));
    // socket.io de-duplicates delivery to a socket that is in several of the target rooms
    this.server.to([...target]).emit(eventType, envelope);
    return envelope;
  }
}
