# EFMIS Backend — Architecture & Conventions

NestJS 11 · TypeORM 0.3 · PostgreSQL 16 · JWT (passport-jwt) · class-validator DTOs · Swagger · @nestjs/schedule

## Layout

```
src/
  main.ts                    bootstrap: /api prefix, helmet, CORS, ValidationPipe (422), Swagger /api/docs
  app.module.ts              root module + global guards (JwtAuthGuard -> PermissionsGuard) + AllExceptionsFilter
  health.controller.ts       GET /api/health (public)
  config/configuration.ts    typed env config (ConfigService.get('db'), 'jwt.secret', 'demoMode', ...)
  common/
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
8. **Numbers**: entity numeric columns are `double precision` (returned as JS numbers).
9. **Swagger**: `@ApiTags('<Area> (REQ-x)')`, `@ApiBearerAuth()` on controllers, `@ApiOperation({ summary })` on routes.
10. **Status codes**: POST that creates → 201 (default); POST actions (approve, vote, decide …) → `@HttpCode(200)`.

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
