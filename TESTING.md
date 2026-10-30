# Backend testing

Every roadmap phase ships with its tests; CI (`.github/workflows/ci.yml`) runs all of them on every push and PR.

| Layer | Where | Run | Time |
|---|---|---|---|
| Unit (no database) | `src/**/<name>.spec.ts`, next to the code | `npm test` | ~3 s |
| Feature e2e (API + database) | `test/<feature>.e2e-spec.ts` — one file per feature | `npm run test:e2e -- test/<feature>.e2e-spec.ts` | 20–40 s per file |
| Area scope | `test/scope.e2e-spec.ts` | `npm run test:e2e -- test/scope.e2e-spec.ts` | ~30 s |
| Architecture | `src/architecture.spec.ts` (layout, platform never imports domain) | `npm test` | <1 s |
| Lint (max 300 lines per file) | `.eslintrc.js` | `npm run lint` | ~5 s |
| API contract | `openapi.json` must match the code; undocumented responses may not increase | `npm run build && npm run openapi:check -- --max=205` | ~40 s |

## What each phase adds

1. **Unit tests** for pure logic (rules, calculations, workflow definitions via `validateDefinition`).
2. **`test/<feature>.e2e-spec.ts`** for the feature's endpoints and its workflow (use `startTestApi()`,
   `loginAs(role)`, `loginAsUser(SEED_USERS.ADAMA_WOREDA)` from `test/helpers/e2e.ts`).
3. **A case in `test/scope.e2e-spec.ts` for every new route** — an officer of another unit gets 403 `OUT_OF_SCOPE`, or
   the route is listed in `EXEMPT` with the reason. The coverage test fails otherwise.
4. `@ApiOkResponse({ type })` on every new route, then `npm run build` (commit `openapi.json`) and lower the
   `--max` number in CI when the phase documents old routes.

The Phase 0 specs (`app`, `platform`, `rbac`, `architecture`, `logistics`, `custody`) stay as they are; the tests in
`app.e2e-spec.ts` for an area move into that feature's file when its phase rebuilds the area.

## Rules

- No file above 300 lines of code (`max-lines`). Files listed in `eslint-legacy-large-files.js` predate the rule and
  are split in their phase; never add to that list.
- Tests use the seeded demo data (`SeedService`); a test that needs more creates it through the API or a service.
- Local e2e needs the Docker Postgres and MinIO (`npm run db:up`); tests reset the `efmis_test` database and empty the
  `efmis-test-*` buckets, never `efmis` or the dev buckets.
- File storage tests: `test/storage.e2e-spec.ts` (buckets, round trip, duplicate, rollback, retention, import).
