# EFMIS — production runbook

Stack: Next.js frontend (`../EFMIS`) → NestJS API (this folder) → PostgreSQL 16 (TypeORM, migrations only) + Redis 7,
GPS: Teltonika trackers → Traccar (GPS Tracking Platform) → NestJS webhook (+ read-only polling as safety net).

## 1. First deployment

1. Copy `.env.production.example` → `.env` on the server and fill every `<…>`. The API **refuses to start** in production when
   `JWT_SECRET` is shorter than 32 characters, `DEMO_MODE` or `DB_SEED_ON_START` is on, `TRACCAR_WEBHOOK_SECRET` is missing,
   or `CORS_ORIGINS` contains `*`.
2. Start PostgreSQL + Redis + Traccar + API: `docker compose --profile full up -d` (Traccar stores its data in its own `traccar`
   database; `docker/init-traccar-db.sql` creates it on a fresh volume).
3. Migrations run automatically before the API starts (`dist/database/run-migrations.js`). Never use `synchronize`.
4. Create the first administrator (prints a temporary password once; must be changed at first sign-in):
   `docker compose exec api node dist/database/create-admin.js --email admin@<domain> --name "System Administrator"`
5. Sign in at `/admin`: create roles (or use the built-in ones), users with their administrative / warehouse scope.
6. Traccar: open `http://<traccar-host>:8082` (keep it on the private network), create the admin account, then a **read-only**
   service user for `TRACCAR_USER` with access to all devices. Register every tracker with its IMEI as *identifier* — the same
   value as the EFMIS GPS device's `providerDeviceId`. Point the Teltonika devices (Configurator → GPRS → server) at the Traccar
   host, port **5027** TCP. Check `GET /api/v1/integrations/traccar/status` → `mode: POLL_AND_WEBHOOK`, `lastError: null`.

## 2. Schema changes (developers)

```
npm run migration:generate   # then REVIEW the file
npm run migration:run
```
TypeORM generates `DROP COLUMN` + `ADD COLUMN` for type/length changes — that **erases the column's data**. Rewrite such pairs as
`ALTER COLUMN … TYPE … USING …` (see `1791981840314-RbacUserManagement.ts` and `1791982843897-LotsCustodyIncidentsDecimals.ts`).
After running, `npx typeorm-ts-node-commonjs -d src/database/data-source.ts schema:log` must report "up to date".
Take a backup before migrating a database that holds real data.

## 3. Authorisation model

- Permission keys live in code (`src/common/constants/permissions.ts` + descriptions in `permission-catalog.ts`); grants live in the
  database (`role_permissions`) and are edited by administrators at `/admin`. A permission new to the catalogue is granted once to its
  default roles at startup; afterwards administrators own it.
- A role's **base role** (a built-in role) decides *which data* its users see (kebele/woreda/zone/region, own warehouse, own trips);
  its permission set decides *what they can do*. Changes apply within ~5 s on every API instance.
- Safeguards: the System Administrator role always keeps `users:manage` + `roles:manage`; no change may leave the system without an
  active administrator; system roles cannot be deleted or deactivated; roles in use cannot be deleted.
- Accounts: temporary passwords (shown once) force a password change; deactivation, password reset and "sign out everywhere"
  revoke existing tokens immediately; 5 failed sign-ins lock the identifier for 15 minutes (shared via Redis).

## 4. Stock ledger rules

- Quantities are `numeric(14,3)` (exact to the kilogram); every movement is an `inventory_transactions` row with the lot moved.
- Stock is held in **lots** (QR batches) with QC status `PASSED | PENDING | HELD | REJECTED` and expiry. Only PASSED, unexpired lots are
  reservable (first-expiry-first-out unless the shipment names its QR lot); loading is refused when an allocated lot was put on hold.
  Quality decisions: `POST /api/v1/inventory/lots/:id/qc` (permission `inventory:qc`, ECAE by default).
- Deliveries are received into the same lot numbers at the destination (`source_lot_id` links them) — end-to-end traceability.
- Waybill numbers are unique; issued at dispatch (`WB-<year>-<n>`) when not entered.

## 5. Operations

- **Backups**: `docker/backup.sh` (daily cron) dumps the `efmis` and `traccar` databases (custom format, integrity-checked) and the
  private file storage, keeps 14 days. Copy the backup folder off-site. **Test a restore** monthly:
  `pg_restore -d efmis_restore_test --clean --if-exists efmis-<stamp>.dump`.
- **Health**: `GET /api/health` (container HEALTHCHECK). Background jobs / dead letters: `GET /api/v1/jobs/stats`, `/failures`.
- **Logs**: never contain licence numbers, IMEI, documents or passwords; audit trail is hash-chained (`audit_log`, immutable).
- **Private files**: proof of delivery and driver documents live under `PROOF_STORAGE_DIR` (mount a persistent volume), served only
  through authorised, audited endpoints.

## 6. Still needed from the organisation (cannot be configured in code)

| Item | Used for |
|---|---|
| Public domain + TLS certificate (HTTPS/WSS) | portal, API, realtime socket |
| Server(s) / hosting decision, private network for DB/Redis/Traccar | deployment |
| SMS gateway credentials | OTP sign-in, notifications (demo mode currently returns OTPs) |
| Fayda, NRLAIS, NSIS, EABC API endpoints + credentials | identity / land verification, soil data, procurement |
| Teltonika devices + SIMs, APN settings | real trackers (Traccar + protocol already verified with Codec 8) |
| OSRM (or other road-routing) server | road-based ETA (straight-line estimate until configured) |
| Off-site backup target | disaster recovery |
