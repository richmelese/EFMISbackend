# EFMIS Backend — Architecture & Conventions

NestJS 11 · TypeORM 0.3 · PostgreSQL 16 · JWT (passport-jwt) · class-validator DTOs · Swagger · @nestjs/schedule

## Layout

```
src/
  main.ts                    bootstrap: /api prefix, helmet, CORS, ValidationPipe (422), Swagger /api/docs
  app.module.ts              root module + global guards (JwtAuthGuard -> PermissionsGuard) + AllExceptionsFilter
  health.controller.ts       GET /api/health (public)
  config/configuration.ts    typed env config (ConfigService.get('db'), 'jwt.secret', 'demoMode', ...)
  openapi-export.ts          writes openapi.json without a database (runs after `npm run build`)
  common/
    events/                  DomainEvents: in-transaction domain events between modules
    constants/permissions.ts RBAC matrix (Role enum, PERMISSIONS, can())
    constants/rules.ts       business thresholds from the requirements spec (RULES)
    decorators/index.ts      @Public() @RequirePermissions(...) @CurrentUser() @ReqCtx()
    guards/                  JwtAuthGuard (global), PermissionsGuard (global)
    filters/                 AllExceptionsFilter -> { error: { code, message, details } }
    dto/signature.dto.ts     SignatureDto { pin?, password? } — extend it for every approval endpoint
    utils/helpers.ts         nowStamp, stamp(Date), parseStamp, sha256, shortId, round, fmtMT, paginate, toCsv, daysSince
    utils/errors.ts          Errors.badRequest / unauthorized / forbidden / notFound / conflict / unprocessable / tooMany
    utils/scope.ts           data scope: scopeCondition(user, alias, column?), inScope / assertInScope (inside the
                             user's unit), unitVisible / assertUnitVisible (inside or above it), isNational
    types/auth-user.ts       AuthUser, RequestContext
  database/
    typeorm.config.ts        options (SnakeNamingStrategy: camelCase props -> snake_case columns)
    data-source.ts           TypeORM CLI data source
    migrations/              InitialSchema + ImmutableAuditTriggers (audit_log, approval_actions are write-once)
    seeds/                   SeedService (frontend master data -> DB), run-seed.ts
  modules/
    <platform, all @Global>  settings, audit, users, auth, signatures, notifications, alerts, comments,
                             approvals, external (Fayda/NRLAIS/NSIS adapters), hierarchy (facade), aggregation,
                             admin-units (ltree unit tree), seasons, workflow (approval engine), outbox
    <domains>                farmers, kebele-review, reviews, regional, national, quota, integrations,
                             reports, ussd, dashboard, scheduler
```

Each domain module: `<name>.module.ts`, `<name>.controller.ts` (thin: routing, DTOs, guards, Swagger),
`<name>.service.ts` (business logic, transactions), `dto/*.dto.ts`, `entities/*` (entities live with their owning module).

## Rules every module follows

1. **Routes** keep stable paths and JSON response shapes (documented in Swagger at `/api/docs`) — the
   frontend data shapes (`EFMIS/js/data.js`) are the contract. List endpoints return arrays; optional paging uses
   `paginate(req, res, items)` (headers `X-Total-Count`, …).
2. **Auth/RBAC**: every route is authenticated by default. Declare permissions with `@RequirePermissions('x:y', ...)`
   (any-of, from `permissions.ts`). Use `@Public()` only for health, login and the USSD gateway.
   Administrative scope is ONE rule — the record's unit is inside the user's unit (`admin_units.path <@ user path`):
   filter lists with `scopeCondition(user, 'alias', 'unitColumn?')`, check single records with `assertInScope`
   (403 `OUT_OF_SCOPE`); read-only roll-up views of the areas above the user use `assertUnitVisible`. Never compare
   region/zone/woreda/kebele ids by hand. Every route of an area-scoped module needs a case in
   `test/scope.e2e-spec.ts` (or a written exemption) — its coverage test fails otherwise.
3. **Validation**: request bodies are DTO classes with class-validator decorators (no `any` bodies). Validation failures
   become HTTP 422 `VALIDATION_FAILED` automatically. Business-rule violations use `Errors.*` (never raw `HttpException`).
4. **E-signatures**: approvals extend `SignatureDto` and call `signatures.sign(user, dto, targetType, targetId, payload, manager)`
   (400 when missing, 401 when wrong).
5. **Transactions**: multi-row changes run in `dataSource.transaction(async m => ...)`; pass `m` to `audit.record`,
   `signatures.sign`, `notifications.notify`, `approvals.record`, `alerts.raise` so everything commits atomically.
6. **Audit**: every state change calls `audit.record(user, ACTION, targetId, { old, new, reason }, ctx)` (ctx from `@ReqCtx()`).
7. **Timestamps** in responses are `"YYYY-MM-DD HH:mm:ss"` via `stamp(date)`; quantities are numbers (MT / quintals).
8. **Numbers**: quantities and money are exact `numeric` columns via `common/utils/decimal.ts` —
   `@Column(QTY())` (MT, numeric(14,3)), `@Column(NUMERIC(p, s))`, `@Column(MONEY())` — returned as JS numbers.
   Some older columns are still `double precision`; they are converted in the roadmap phase that owns them.
9. **Swagger**: `@ApiTags('<Area> (REQ-x)')`, `@ApiBearerAuth()` on controllers, `@ApiOperation({ summary })` on routes.
10. **Status codes**: POST that creates → 201 (default); POST actions (approve, vote, decide …) → `@HttpCode(200)`.
11. **Versioning**: new and changed routes declare `@Version('1')` → `/api/v1/...`. Existing unversioned routes keep
    their paths until their roadmap phase replaces them; the old route is then marked `deprecated` in Swagger.
12. **API contract**: `npm run build` exports `openapi.json` (no database needed: `src/openapi-export.ts`); the
    frontend generates its typed client from it. Document responses with `@ApiOkResponse({ type: Dto })` /
    `@ApiCreatedResponse` — `npm run openapi:check` lists routes whose response is still undocumented.
13. **Approvals**: new approval flows register a `WorkflowDefinition` (WorkflowRegistry, in the owning module's
    `onModuleInit`), open cases with `workflow.open(...)` in their transaction and react to `WorkflowAdvanced`. The
    frontend reads `available` actions and posts to `/api/v1/workflow/cases/:id/actions`. Statuses are codes.
14. **Side effects**: email / SMS / push / webhooks / external API calls go through `outbox.enqueue(msg, m)` inside the
    transaction (`notifications.notify` does this for EMAIL/SMS/PUSH). Never call a provider from a request.
15. **Domain events** (consistency across modules): the owner publishes inside its transaction,
    `await events.publish(new DemandApproved(...), m)`; subscribers register with `events.subscribe(DemandApproved,
    (e, m) => ...)` and write through `m`, so everything commits or rolls back together. Never write to another
    module's tables directly. Side effects that must not roll back (email, SMS, external APIs) go to the outbox.

## Shared services (inject anywhere — modules are @Global)

| Service | Key methods |
|---|---|
| SettingsService | `get(key, fallback)`, `set(key, value, by)`, `currentSeason()` (name of `SeasonsService.current()`) |
| SeasonsService | `current()`, `byId(id)`, `byName(name)`, `list()`, `makeCurrent(name, m)` |
| AdminUnitsService | `byId`, `findById`, `unitRef(id)` (path + legacy chain), `ancestors`, `children`, `subtree`, `tree(user)`, `pathOf(id)` |
| WorkflowRegistry | `register(definition)`, `get(name)` |
| WorkflowService | `open(definition, { id }, unitId, seasonId, m?)`, `act(user, caseId, action, { pin, comments, details, expectedVersion }, ctx, m?)`, `available(user, case)`, `history(entityType, entityId)`, `processDeadlines()` |
| OutboxService | `enqueue({ channel, payload, dedupeKey?, ackWithinHours?, maxAttempts? }, m)`, `ack(id)`, `registerAdapter(adapter)`, `drain()` |
| AuditService | `record(actor, action, target, details?, ctx?, manager?)`, `list(q)`, `verifyChain()` |
| SignaturesService | `sign(user, cred, targetType, targetId, payload, manager?)`, `verify(id, payload?)`, `findById(id)` |
| NotificationsService | `notify({ userId?, role?, unitId?, title, message, link?, channels? }, manager?)` |
| AlertsService | `raise({ severity, title, category, trigger, affectedArea, actionRequired, sourceType, sourceId, dedupeKey }, manager?)`, `toFrontend(alert)`, `repo` |
| CommentsService | `list(scopeType, scopeId)`, `add(user, scopeType, scopeId, text, parentId?, manager?)` (parses @mentions) |
| ApprovalsService | `record(user, { entityType, entityId, level, action, comments, details, signatureId }, manager?)`, `history(type, id)` |
| ExternalService | `faydaVerify(id, { user, expected })`, `nrlaisVerify(cert)`, `nsisProfile(regionId)`, `nsisRaw(regionId)`; `FAYDA_MESSAGES`, `NSIS_LAYERS` |
| HierarchyService | facade (legacy tables + admin-units): `resolveKebele(id)`, `unitRef(level, id)`, `regionToFrontend(r)`, `nestedRegions(regionId?)`, repos `regions/zones/woredas/kebeles/fertilizerTypes` |
| AggregationService | `drilldown(level, id)`, `nationalSummary()`, `byType(mt)`, `approvedFarmerDemand(col, id)` |
| NationalFiguresService | `carryOver()`, `netImport()`, `updateCarryOver(user, type, changes, manager?)` |
| UsersService | `toAuthUser(user)`, `findActive(id)`, `contactsFor({ userId, role, unitId }, m?)`, `repo` |
| DomainEvents | `publish(event, manager?)`, `subscribe(EventClass, (event, manager?) => …)` |

## Platform modules (Stage B)

- **seasons** — `seasons` (MEHER/BELG/IRRIGATION × year, PLANNING/OPEN/CLOSED, exactly one `is_current`).
  Editing `systemMetadata.currentSeason` in settings switches the current season. Read-only `GET /api/v1/seasons[/current|/:id]`.
- **admin-units** — `admin_units` (COUNTRY, REGION, ZONE, WOREDA, KEBELE, UNION, PC, CITY_ADMIN, SPECIAL_WOREDA) with
  an ltree `path`; region/zone/woreda/kebele rows keep the legacy IDs (path labels: the id with `-` → `_`). The legacy
  tables stay for names/figures/statuses (`regions` holds quota inputs until Phase 8). `users.admin_unit_id` anchors a
  user's scope (derived from the base role + area columns); `AuthUser` carries `adminUnitId` and `unitPath`.
  `GET /api/v1/admin-units/tree | /:id | /:id/children` (user's subtree; ancestors readable for breadcrumbs).
- **workflow** — `workflow_cases` (one per record, or per unit + season; assignee unit, origin unit, due date,
  escalation level, version) and write-once `workflow_actions`. `act()` checks transition → permission → scope
  (case unit inside the user's unit) → comments → e-signature, then writes the action + audit, publishes
  `WorkflowAdvanced` and notifies the roles that act next — in one transaction. The hourly scheduler escalates overdue
  cases up the unit chain (or sends daily reminders). `history()` merges legacy `approval_actions`.
- **outbox** — `outbox_messages` (PENDING → SENT/ACKED, FAILED with exponential back-off, DEAD after maxAttempts).
  The relay polls every `OUTBOX_POLL_MS` (5000; 0 = off; off in tests, which call `drain()`): with `REDIS_URL` it hands
  messages to a BullMQ worker (queue `outbox`), without it delivers inline. EMAIL/SMS/PUSH use logging stub adapters
  until provider credentials exist. Dead messages and overdue acknowledgements publish `OutboxProblem` → one alert
  per channel per day.

## Security notes

- **Signature key**: e-signatures are HMAC'd with `SIGNATURE_SECRET` (key id `sig-v1`), separate from `JWT_SECRET`.
  Each `signatures` row stores its `key_id`; rows signed before the split keep `jwt-legacy` and still verify.
  Production refuses to start if `SIGNATURE_SECRET` is missing, shorter than 32 characters or equal to `JWT_SECRET`.
- **Realtime tickets**: `POST /api/v1/auth/realtime-ticket` returns a 60-second JWT (audience `efmis-realtime`) that
  opens the `/realtime` socket. The REST API rejects it (`TICKET_NOT_FOR_API`), and it carries the session's jti so
  signing out revokes it. This lets the web portal keep the session token in an httpOnly cookie.

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests `src/**/*.spec.ts` (no database) |
| `npm run test:e2e` | End-to-end tests `test/*.e2e-spec.ts` against the `efmis_test` database |

`test/scope.e2e-spec.ts` holds the "wrong unit → 403" case for every route of the area-scoped modules;
`test/platform.e2e-spec.ts` covers seasons, admin-units, workflow (with the test-only definitions in
`test/helpers/workflow-fixtures.ts`) and the outbox.

E2E tests use `test/helpers/e2e.ts`: `startTestApi({ listen?, seed? })` returns `call()`, `loginAs(role)` and
`loginAsUser(SEED_USERS.ADAMA_WOREDA)` — the per-unit users make "wrong unit → 403" scope tests straightforward.
