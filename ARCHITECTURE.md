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
    utils/scope.ts           isNational, scopeCondition(user, alias), inScope, assertInScope (data segmentation)
    types/auth-user.ts       AuthUser, RequestContext
  database/
    typeorm.config.ts        options (SnakeNamingStrategy: camelCase props -> snake_case columns)
    data-source.ts           TypeORM CLI data source
    migrations/              InitialSchema + ImmutableAuditTriggers (audit_log, approval_actions are write-once)
    seeds/                   SeedService (frontend master data -> DB), run-seed.ts
  modules/
    <platform, all @Global>  settings, audit, users, auth, signatures, notifications, alerts, comments,
                             approvals, external (Fayda/NRLAIS/NSIS adapters), hierarchy, aggregation
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
   Administrative scope: filter lists with `scopeCondition(user, 'alias')`, check single records with `assertInScope`.
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
13. **Domain events** (consistency across modules): the owner publishes inside its transaction,
    `await events.publish(new DemandApproved(...), m)`; subscribers register with `events.subscribe(DemandApproved,
    (e, m) => ...)` and write through `m`, so everything commits or rolls back together. Never write to another
    module's tables directly. Side effects that must not roll back (email, SMS, external APIs) go to the outbox.

## Shared services (inject anywhere — modules are @Global)

| Service | Key methods |
|---|---|
| SettingsService | `get(key, fallback)`, `set(key, value, by)`, `currentSeason()` |
| AuditService | `record(actor, action, target, details?, ctx?, manager?)`, `list(q)`, `verifyChain()` |
| SignaturesService | `sign(user, cred, targetType, targetId, payload, manager?)`, `verify(id, payload?)`, `findById(id)` |
| NotificationsService | `notify({ userId?, role?, unitId?, title, message, link?, channels? }, manager?)` |
| AlertsService | `raise({ severity, title, category, trigger, affectedArea, actionRequired, sourceType, sourceId, dedupeKey }, manager?)`, `toFrontend(alert)`, `repo` |
| CommentsService | `list(scopeType, scopeId)`, `add(user, scopeType, scopeId, text, parentId?, manager?)` (parses @mentions) |
| ApprovalsService | `record(user, { entityType, entityId, level, action, comments, details, signatureId }, manager?)`, `history(type, id)` |
| ExternalService | `faydaVerify(id, { user, expected })`, `nrlaisVerify(cert)`, `nsisProfile(regionId)`, `nsisRaw(regionId)`; `FAYDA_MESSAGES`, `NSIS_LAYERS` |
| HierarchyService | `resolveKebele(id)`, `unitRef(level, id)`, `regionToFrontend(r)`, `nestedRegions(regionId?)`, repos `regions/zones/woredas/kebeles/fertilizerTypes` |
| AggregationService | `drilldown(level, id)`, `nationalSummary()`, `byType(mt)`, `approvedFarmerDemand(col, id)` |
| NationalFiguresService | `carryOver()`, `netImport()`, `updateCarryOver(user, type, changes, manager?)` |
| UsersService | `toAuthUser(user)`, `findActive(id)`, `repo` |
| DomainEvents | `publish(event, manager?)`, `subscribe(EventClass, (event, manager?) => …)` |

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

E2E tests use `test/helpers/e2e.ts`: `startTestApi({ listen?, seed? })` returns `call()`, `loginAs(role)` and
`loginAsUser(SEED_USERS.ADAMA_WOREDA)` — the per-unit users make "wrong unit → 403" scope tests straightforward.
