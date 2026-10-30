# EFMIS Backend (NestJS)

REST API for the **Ethiopian Fertilizer Supply Chain Management Information System**. It implements the *EFMIS Requirements Specification (August 2026)* and the *Logistics & Driver Management Full Flow* specification, and serves the Next.js frontend in `../EFMIS`.

**Stack:** NestJS 11 · TypeORM 0.3 · PostgreSQL 16 · Redis 7 + BullMQ · Socket.IO · JWT (passport) · class-validator · Swagger/OpenAPI · @nestjs/schedule · Jest + Supertest

The architecture and coding conventions are in [ARCHITECTURE.md](ARCHITECTURE.md). The logistics module contracts are in [LOGISTICS.md](LOGISTICS.md).

## Quick start

```bash
cd EFMISbackend
npm install
cp .env.example .env
docker compose up -d postgres redis   # PostgreSQL 16 on :55433 (dbs efmis, efmis_test) + Redis 7 on :56379
npm run start:dev      # http://localhost:4000/api   — migrations + seed run automatically on first start
```

- **Swagger UI:** http://localhost:4000/api/docs. Every endpoint is listed with its request DTO; click *Authorize* and paste a token.
- **Health check:** `GET /api/health`.
- **Redis is optional in development.** Leave `REDIS_URL` empty and queue jobs run inline, with an in-memory cache.

| Script | What it does |
|---|---|
| `npm run build` / `npm run start:prod` | Production build and run |
| `npm run test:e2e` | 35 end-to-end tests (22 EFMIS workflow + 13 logistics scenario) against the `efmis_test` database (rebuilt on each run) |
| `npm run seed:reset` | Drop the schema, re-run migrations, reseed |
| `npm run migration:generate` / `migration:run` / `migration:revert` | TypeORM migrations |
| `docker compose --profile full up --build` | API, Postgres and Redis all in containers |

## Demo accounts

- **Password** for every demo account: **`Efmis@2026`**
- **E-signature PIN** for every demo account: **`1234`**

Approvals need `"pin": "1234"` in the request body.

| Role | Email | Scope |
|---|---|---|
| DA | da.bekele@efmis.gov.et | Kebele KEB-01 (Wonji Gefersa) |
| KEBELE | kebele.wonji@efmis.gov.et | KEB-01 |
| WOREDA | woreda.adama@efmis.gov.et | Adama Woreda |
| ZONE | zone.eshewa@efmis.gov.et | East Shewa Zone |
| REGION | boa.oromia@efmis.gov.et | Oromia |
| MOA | melesse.mekonnen@moa.gov.et, admin.moa@efmis.gov.et | National |
| FTWG (Chair) | kassa.mengistu@ftwg.gov.et | National |
| ATI | mandefro.nigussie@ati.gov.et | National |
| EABC / PMO / ECAE / AUDITOR / ADMIN | procurement@eabc.gov.et / delivery@pmo.gov.et / lab@ecae.gov.et / auditor@efmis.gov.et / admin@efmis.gov.et | — |
| LOGISTICS_MANAGER | logistics.manager@eslse.gov.et | Whole fleet |
| DISPATCHER | dispatch@eslse.gov.et | Whole fleet |
| FLEET_MANAGER | fleet@eslse.gov.et | Trucks & GPS devices |
| DRIVER | solomon.kebede@eslse.gov.et (available), tadesse.hailu@eslse.gov.et (on trip) | Own trips only |
| WAREHOUSE_OPERATOR | store.mojo@eslse.gov.et, store.adamaunion@efmis.gov.et | Own warehouse only |

Other ways to log in:
- **1-click persona login** (used by the LoginPage, `DEMO_MODE` only): `POST /api/auth/demo-login {"role":"MOA"}`.
- **Fayda ID `FAYDA-ETH-8829-4921` or phone `0911234567`:** call `POST /api/auth/otp/request`, then `POST /api/auth/otp/verify`. In demo mode the OTP comes back in the response as `devOtp`.

## Modules ↔ requirements

| Module | Requirement | Main routes (`/api/...`) |
|---|---|---|
| auth, users | REQ-1.7-001 RBAC | `auth/login`, `auth/otp/*`, `auth/demo-login`, `auth/me`, `auth/logout`, `users` |
| farmers | REQ-1.1-001/002/003/004/005/006 | `farmers` CRUD, `farmers/sync`, `farmers/:id/documents`, `integrations/fayda/verify`, `integrations/nrlais/verify`, `integrations/nsis/:regionId` |
| kebele-review | REQ-1.1-007 | `kebele/queue`, `kebele/farmers/:id/approve\|reject\|request-revision\|partial`, `kebele/bulk` |
| aggregation | REQ-1.2-001/002, REQ-1.3-001, REQ-INT-006 | `aggregation/drilldown`, `aggregation/national` |
| reviews | REQ-1.2-003/004 | `reviews/:woreda\|zone/:id`, `reviews/adjustments`, `reviews/comments`, `reviews/:level/:id/decision`, `reviews/scenario` |
| regional | REQ-1.2-005/007, REQ-1.3-002 | `regions`, `regions/:id/soil`, `/analysis`, `/pre-submission-check`, `/submit`, `/submissions` |
| national | REQ-1.3-001…005 | `national/summary`, `/net-import`, `/carry-over`, `/ftwg/sessions/*`, `/documents/*` (sign, reject, verify) |
| quota | REQ-1.4-001…010 | `quota/provisional`, `/weights`, `/runs`, `/adjustment-requests`, `/allocations` (children, approve, delivery, amendments), `/letters`, `/procurement-requests` |
| integrations | REQ-INT-001…004 | `integrations/procurement\|quality\|logistics\|financials` + partner feeds (tenders, vessels, inspections, GPS trucks, warehouses, ECX) |
| alerts | REQ-1.2-006, REQ-INT-005 | `alerts` (also `/api/v1/alerts`), `alerts/summary`, `alerts/:id/acknowledge\|assign\|resolve\|close\|reopen\|snooze\|toggle` |
| audit | REQ-1.7-002 | `audit`, `audit/verify`, `audit/export` |
| reports | Daily Reports Hub | `reports/daily-summary/*`, `reports/regional/*` |
| ussd | REQ-1.4-008 | `ussd` (*804#, gateway and simulator) |
| dashboard | REQ-1.6-001 | `meta`, `bootstrap`, `dashboard/overview`, `dashboard`, `copilot/ask` |
| notifications, settings, scheduler | REQ-1.2-006, configurable thresholds, escalations | `notifications`, `settings/:key`, `scheduler/run` |
| logistics/* | Logistics & Driver Management spec | `/api/v1/...` — see the next section |

## Logistics & Driver Management

The data path is: Teltonika tracker → GPS Tracking Platform (Traccar) → tracking adapter → PostgreSQL + Redis/BullMQ → WebSocket → Next.js.

- **Versioned routes:** every logistics REST route lives under `/api/v1/...`; the EFMIS routes stay unchanged. The frontend's `/api/integrations/logistics` (GPS fleet table and warehouse utilization) keeps its exact shape, but is now computed from live trucks, trips, drivers and the inventory ledger.
- **Separate lifecycles:**
  - Shipment, trip and delivery each have their own status rules. `DELAYED` is a flag, not a status.
  - A driver's employment, verification and availability are tracked separately.
  - A truck's operational status, its availability and its GPS connectivity are tracked separately.
- **No double booking:** row locks plus partial unique indexes allow only one active trip per truck and one active assignment per driver. Eligibility checks give explicit reasons, such as licence class, expiry, leave, capacity, cargo type or GPS required.
- **GPS ingestion:**
  - Positions arrive through a Traccar webhook (`POST /api/v1/integrations/traccar/positions`, header `X-Traccar-Secret`) or a poller (`TRACCAR_URL`).
  - Duplicates are dropped by provider position id, and out-of-order points are stored but never move a truck backwards.
  - Unknown devices are rejected and kept for diagnostics.
  - Devices are flagged stale or offline by configurable thresholds (settings key `logisticsThresholds`).
- **Tracking processor** (BullMQ `tracking-events` queue):
  - geofence enter/exit with hysteresis
  - milestones
  - route deviation against a corridor
  - throttled ETA (OSRM-compatible `ROUTING_PROVIDER_URL`, or a road-factor estimate)
  - de-duplicated delay alerts
  - stationary-truck alerts
  - automatic `IN_PROGRESS` and `ARRIVED` trip transitions
- **WebSocket** (`/realtime`, Socket.IO):
  - Clients send their JWT in the handshake (`auth: { token }`).
  - Fleet roles join `fleet:all`. Drivers only receive their own trips, and storekeepers only their warehouse.
  - Events follow spec §16 (`truck.location.updated`, `trip.status.updated`, `shipment.delayed`, `geofence.entered`, …), each carrying `eventId`, `occurredAt` and `payloadVersion`.
- **Inventory:** an append-only ledger tracks reserve, dispatch, delivery receipt, discrepancy, adjustment and transfer. Proof-of-delivery files and driver documents are stored privately (`PROOF_STORAGE_DIR`) and served only through audited endpoints.
- **Queues:** with Redis, BullMQ retries with exponential backoff, and failed jobs go to a dead-letter table (`/api/v1/jobs/failures`). Without Redis, jobs run inline.

| Area | Routes (`/api/v1/...`) |
|---|---|
| Drivers | `drivers` CRUD, `drivers/:id/verify`, `/suspend`, `/reactivate`, `/documents`, `/availability`, `/trips`, `/performance`, `/audit`; `drivers/availability`, `drivers/eligible`, `drivers/expiring`; `driver-documents/:id/verification`, `driver-documents/:id/file` |
| Fleet | `vehicle-types`; `trucks` (+ `/:id/status`, `/:id/locations`); `gps-devices` (+ `/:id/assign-truck`, `/unassign`, `/retire`, `/diagnostics`) |
| Tracking | `tracking/active`, `tracking/trucks/:id`, `tracking/simulate`, `tracking/positions`, `integrations/traccar/positions`, `integrations/traccar/events`, `integrations/traccar/status` |
| Shipments / Trips / Delivery | `shipments` (+ `plan`, `hold`, `release-hold`, `cancel`, `delivery-confirmations` [Idempotency-Key, proof upload]); `trips` (+ `assignments`, `accept`, `checklist`, `loading/start`, `loading`, `dispatch` [Idempotency-Key], `arrive`, `unloading`, `complete`, `incidents`, `resume`, `return`, `abort`, `events`); `deliveries/:id/proof` |
| Routes & geofences | `routes` (+ `/:id/milestones`, `estimate`); `geofences` (+ `/:id/events`); `trips/:id/milestones`, `trips/:id/eta` |
| Warehouses & inventory | `warehouses` (+ `/:id/inventory`, `/:id/discrepancies`); `products`; `inventory/transactions` |
| Operations | `dashboard/summary`; `reports/trips`, `reports/utilization`, `reports/gps-uptime`, `reports/stock-discrepancies`; `alerts`; `jobs/stats`, `jobs/failures` |

## Connecting the frontend

- **Easiest path:** after login, call `GET /api/bootstrap`. It returns the same object as `EFMIS_DATA` in `EFMIS/js/data.js` (including `logistics.gpsFleet` and `warehouseUtilization`, now live), filtered to what the role may see. Use that wherever the components import `EFMIS_DATA`.
- **Per-action endpoints:** the components' buttons have their own endpoints. For example, KebeleApproval `handleApprove` calls `POST /api/kebele/farmers/:id/approve`.
- **Endpoint reference:** every route, request body and response shape is documented in Swagger at `http://localhost:4000/api/docs`.
- **Live map:** connect to Socket.IO namespace `/realtime` with the user's token, then listen for `truck.location.updated` to move markers without polling.
- **Errors:** every error has the form `{ "error": { "code", "message", "details" } }`. Validation failures return HTTP 422.

## Built-in safeguards

- **Global guards:** every route requires a JWT unless marked `@Public`. A permission guard on each route enforces the RBAC matrix in `common/constants/permissions.ts`.
- **Data segmentation:** users only see farmers and other records in their own region, zone, woreda or kebele. Drivers only see their own trips, and warehouse operators only their own warehouse.
- **E-signatures:** every approval needs a PIN or password. Each signature is bound to a SHA-256 of the approved content and created inside the same transaction as the change.
- **Immutable audit trail:** the audit log is hash-chained and checkable with `GET /audit/verify`. `audit_log` and `approval_actions` are write-once, enforced by Postgres triggers. Critical logistics actions (assignment, loading, dispatch, delivery, device pairing) are audited with before/after values.
- **Concurrency:** Farm IDs, shipment/trip numbers, the audit chain and document numbers are allocated under advisory locks. Alert IDs come from a sequence. Truck and driver double booking is blocked by row locks plus unique indexes.
- **Idempotency:** dispatch, delivery confirmation and incoming GPS positions are safe to retry.
- **Throttling:** login endpoints are rate-limited.

## Before production

- **Placeholder integrations:** Fayda, NRLAIS, NSIS and EABC are reached through `modules/external/external.service.ts`, which currently returns deterministic test data. Wire in the real OAuth 2.0 calls once the endpoints are issued.
- **E-signatures:** they currently use HMAC. Proclamation 1078/2018 calls for government PKI (X.509); replace the HMAC in `modules/signatures/signatures.service.ts`. Callers keep the same interface.
- **Notification gateways:** the delivery worker sends email/SMS/push through `EMAIL_PROVIDER` / `SMS_PROVIDER` / `PUSH_PROVIDER`, which currently only log. Plug in real gateways.
- **Required settings:** set a strong `JWT_SECRET`, `TRACCAR_WEBHOOK_SECRET` and `DEMO_MODE=false`; the app refuses to start in production otherwise. Set `USSD_GATEWAY_KEY` too.
- **Logistics integrations:** give the Traccar poller a least-privilege service account, and point `ROUTING_PROVIDER_URL` at an OSRM-compatible routing service for road-based ETAs.
- **Multiple instances:** login lockout counters are in-memory; move them to Redis if you run more than one API instance. Also add the Socket.IO Redis adapter so WebSocket rooms are shared across instances.
- **Rollout:** follow spec §20. Pilot with one truck, then 3–5, then 10–20, and load-test the GPS event volume and WebSocket connections before rolling out to the full fleet.
