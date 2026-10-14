# Logistics & Driver Management — module contracts

Source spec: *Logistics_and_Driver_Management_Full_Flow* (Teltonika → GPS Tracking Platform (Traccar) → NestJS → PostgreSQL + Redis/queues → WebSocket → Next.js).
General conventions: see [ARCHITECTURE.md](ARCHITECTURE.md) (DTOs, `Errors.*`, audit, transactions, `@RequirePermissions`, `stamp()`).

## Logistics-specific rules

- **REST versioning**: every logistics controller is `@Controller({ path: 'drivers', version: '1' })` → `/api/v1/drivers`.
  Existing EFMIS routes stay unversioned (`/api/...`). Alerts are served at both `/api/alerts` and `/api/v1/alerts`.
- **IDs** are UUIDs (`ParseUUIDPipe`). Human numbers: `employeeNumber`, `fleetCode`, `SH-1001`, `TR-1001`, route `code`.
- **Lists**: return `{ items, total, page, pageSize }` for logistics list endpoints (`?page=1&pageSize=50`, max 200), with filters as query params.
  (Exception: the EFMIS frontend adapter `/api/integrations/logistics` keeps its original array shapes.)
- **Status machines**: use `assertTransition()` + `SHIPMENT_TRANSITIONS` / `TRIP_TRANSITIONS` from `src/common/utils/state-machine.ts`
  (409 `CONFLICT` "Invalid … status transition"). Keep separate: driver employment vs verification vs availability; truck operational vs
  availability vs GPS connectivity; shipment vs trip vs delivery. `DELAYED` is the `Shipment.isDelayed` flag, not a status.
- **Double booking**: lock rows (`setLock('pessimistic_write')`) for the truck and driver inside the transaction AND rely on the DB partial unique
  indexes (`uq_truck_active_trip`, `uq_driver_active_assignment`) — map unique violations to 409.
- **Realtime**: after commit, publish with `RealtimeService.publish(eventType, entities, payload)` using the event names of
  `RealtimeEventType` (doc §16). Include `warehouseIds` (origin/destination) and `driverId` so scoped sockets receive them.
- **Alerts**: `AlertsService.raise({ severity, title, category: 'Logistics' | 'Logistics Delays' | 'Fleet & GPS' | 'Driver Compliance' | 'Inventory', …, dedupeKey })`
  then `realtime.publish('alert.created', …)`. Always pass a `dedupeKey` for automatic conditions.
- **Queues**: `JobsService.register(QUEUES.X, jobName, handler)` in `onModuleInit`; `JobsService.dispatch(QUEUES.X, jobName, data, { jobId })`.
  Works with Redis (BullMQ, retries + dead-letter) or inline without Redis. Hot state: `HotStateService` (`setJson/getJson/setOnce`).
- **Sensitive data** (licence number, IMEI, SIM, documents, proof of delivery): only with `drivers:sensitive` / `devices:manage`;
  never log it; files in private storage `ConfigService.get('logistics.proofStorageDir')/<area>/<uuid>` (NOT under `uploadDir`), served only via
  authorised endpoints that audit the access. Uploads: JPEG/PNG/PDF, size ≤ `maxUploadBytes`, sha256 duplicate check.
- **Scoping**: `FLEET_WIDE_ROLES` see everything; `DRIVER` sees only trips/shipments where `trip.primaryDriverId` = their driver
  (`DriversService.driverForUser(user.id)`); `WAREHOUSE_OPERATOR` sees shipments/inventory of `user.warehouseId` only.
- **Times**: entity columns are `timestamptz` Dates; API output uses ISO 8601 strings (`toISOString()`) for logistics endpoints.

## Ownership & cross-module contracts (implement EXACTLY these signatures; they are called by other modules)

### drivers/ — DriversModule (exports DriversService)
```ts
toFrontend(d: Driver, opts?: { sensitive?: boolean }): any                     // licenceNumber masked unless sensitive
driverForUser(userId: string): Promise<Driver | null>
checkEligibility(driverId: string, ctx: { vehicleTypeId?: string | null; from: Date; to: Date; excludeTripId?: string },
                 manager?: EntityManager): Promise<{ eligible: boolean; reasons: string[] }>
setAvailability(driverId: string, status: 'AVAILABLE' | 'ASSIGNED' | 'ON_TRIP', manager?: EntityManager): Promise<void>
```
Eligibility reasons (exact strings are free text but must cover): employment not ACTIVE; not VERIFIED; licence expired before `to`;
licence class not allowed for vehicle type (`VehicleType.allowedLicenceClasses`); required documents expired; availability window
(LEAVE/UNAVAILABLE) overlapping [from,to]; already has an ACTIVE assignment on another trip (ignore `excludeTripId`); availabilityStatus not AVAILABLE.

### fleet/ — FleetModule (exports FleetService)
```ts
truckToFrontend(t: Truck, opts?: { device?: GpsDevice | null; vehicleType?: VehicleType | null }): any
deviceToFrontend(d: GpsDevice, opts?: { sensitive?: boolean }): any
connectivityOf(lastSeenAt: Date | null): 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER_SEEN'   // thresholds from settings 'logisticsThresholds'
checkTruckEligibility(truckId: string, ctx: { quantity: number; cargoType?: string | null; requiresTracking: boolean; excludeTripId?: string },
                      manager?: EntityManager): Promise<{ eligible: boolean; reasons: string[] }>
setAvailability(truckId: string, status: 'AVAILABLE' | 'RESERVED' | 'ON_TRIP', manager?: EntityManager): Promise<void>
eligibleTrucks(q: { quantity; cargoType?; requiresTracking?: 'true'|'false'; excludeTripId? }): Promise<{ eligible: any[]; ineligible: { truck; reasons }[] }>
```
`GET /api/v1/trucks/eligible?quantity=20&cargoType=BAGGED_FERTILIZER` backs the assignment modal (eligible trucks smallest-first, and why
the others cannot be selected), mirroring `GET /api/v1/drivers/eligible`.

### tracking/ — TrackingModule (exports TrackingService)
```ts
ingest(positions: NormalizedPosition[], source: PositionSource): Promise<IngestResult[]>   // tracking.types.ts
currentPositions(filter?: { truckIds?: string[] }): Promise<any[]>
```
After each ACCEPTED (in-order) position: update truck last position + device lastSeenAt (+ Redis hot copy), publish
`truck.location.updated`, and `jobs.dispatch(QUEUES.TRACKING, TRACKING_POSITION_JOB, PositionProcessedEvent, { jobId: 'pos-'+locationId })`.

### routing/ — RoutingModule (exports RoutingService, consumes the TRACKING queue)
```ts
estimate(origin: LatLng, destination: LatLng, viaGeometry?: LatLng[]): Promise<{ distanceKm: number; durationMin: number; geometry: LatLng[]; source: 'ROUTING_PROVIDER' | 'STRAIGHT_LINE' }>
initTripMilestones(tripId: string, routeId: string | null, plannedStartAt: Date, manager?: EntityManager): Promise<void>
refreshEta(tripId: string, force?: boolean): Promise<{ estimatedArrivalAt: Date | null; remainingDistanceKm: number | null } | null>
```
Registers the handler for `QUEUES.TRACKING` / `TRACKING_POSITION_JOB` that runs geofences (hysteresis), milestones, route deviation,
throttled ETA, delay detection, stationary-truck detection, and calls `TripsService.systemTransition` for IN_PROGRESS / ARRIVED.
Fixes whose `recordedAt` is before the trip's `actualStartAt` (buffered/late device uploads) never drive these automatic transitions.

### shipments/ — ShipmentsModule (exports ShipmentsService, TripsService, DeliveriesService)
```ts
TripsService.systemTransition(tripId: string, to: 'IN_PROGRESS' | 'ARRIVED', reason: string, at?: Date): Promise<boolean>  // no-op (false) if not allowed
TripsService.activeTripForTruck(truckId: string): Promise<Trip | null>
TripsService.tripToFrontend(t: Trip, opts?): Promise<any>
ShipmentsService.shipmentToFrontend(s: Shipment): Promise<any>
```

### warehouses/ — WarehousesModule (exports WarehousesService, InventoryService)
```ts
InventoryService.reserve(warehouseId, productId, qty, ref: { type: 'SHIPMENT'|'TRIP'|'DELIVERY'|'MANUAL'|'FEED'; id: string }, actor: string, manager?): Promise<void>   // 422 if available < qty
InventoryService.release(warehouseId, productId, qty, ref, actor, manager?): Promise<void>
InventoryService.dispatchLoaded(warehouseId, productId, loadedQty, reservedQty, ref, actor, manager?): Promise<void>   // onHand -= loaded, reserved -= reservedQty
InventoryService.receive(warehouseId, productId, qty, type: 'RECEIPT'|'DELIVERY_RECEIPT'|'RETURN'|'TRANSFER_IN', ref, actor, manager?): Promise<void>
InventoryService.record(input: { warehouseId; productId; type; quantity; onHandDelta; reservedDelta; referenceType?; referenceId?; notes? }, actor, manager?): Promise<InventoryTransaction>
InventoryService.balance(warehouseId, productId): Promise<{ onHand: number; reserved: number; available: number }>
WarehousesService.warehouseToFrontend(w: Warehouse): Promise<any>
```

### dashboard/ — LogisticsDashboardModule (exports LogisticsViewService)
```ts
LogisticsViewService.gpsFleet(): Promise<any[]>              // EXACT frontend shape of EFMIS_DATA.logistics.gpsFleet items
LogisticsViewService.warehouseUtilization(): Promise<any[]>  // EXACT frontend shape of EFMIS_DATA.logistics.warehouseUtilization items
```
gpsFleet item: `{ truckId: fleetCode, driver: 'First Last', vehicleNo: plateNumber, cargo: '40 MT NPSB (Bagged with QR)', lat, lng,
speedKmH, route: 'Origin -> Destination', eta: '16h 20m' | 'DELAYED' | 'ARRIVED' | '-', status: 'NORMAL_MOVING' | 'UNLOADING' | 'STOPPED' | 'STOPPED_ALERT' | 'IDLE',
qrLot, alertReason? }` + extra fields allowed (connectivity, lastUpdate, tripNumber…).
warehouseUtilization item: `{ name, capacityMT, currentStockMT (= Σ onHand), utilPercent, status: 'CAPACITY_ALERT_80' | 'OPTIMAL' }` + extras.

## Settings key `logisticsThresholds` (runtime-configurable; defaults)
```json
{ "gpsStaleMinutes": 10, "gpsOfflineMinutes": 60, "stationaryAlertMinutes": 210, "etaRefreshMinutes": 5, "etaRefreshDistanceKm": 2,
  "delayToleranceMinutes": 30, "routeDeviationKm": 2, "routeDeviationMinPoints": 3, "geofenceMinPoints": 2, "averageSpeedKmh": 45,
  "roadFactor": 1.3, "documentExpiryWarningDays": 30, "maxPositionAgeHours": 72, "maxFutureSkewMinutes": 5 }
```
Read with `settings.get('logisticsThresholds', DEFAULTS)` — DEFAULTS live in `src/modules/logistics/logistics.constants.ts`.
