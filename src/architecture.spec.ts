// Architecture rules that can be checked from the source tree (BACKEND_ARCHITECTURE_PLAN §2, §6).
import * as fs from 'fs';
import * as path from 'path';

const MODULES = path.join(__dirname, 'modules');
const PLATFORM = ['auth', 'users', 'settings', 'audit', 'signatures', 'comments', 'alerts', 'notifications', 'admin-units', 'seasons', 'workflow', 'outbox', 'storage', 'external', 'scheduler'];
const DOMAIN = ['farmers', 'reviews', 'regional', 'aggregation', 'national', 'quota', 'integrations', 'reports', 'dashboard', 'ussd', 'logistics'];

/**
 * Platform → domain imports that predate the rule. Each is removed in the phase noted; nothing may be added here
 * without the same justification.
 */
const KNOWN_DEBT: Record<string, string> = {
  'scheduler -> farmers': 'kebele reminders read farmers; moves onto workflow deadlines in Phase 4',
  'scheduler -> national': 'document signature reminders; moves onto workflow deadlines in Phase 7',
  'scheduler -> quota': 'letter / PO reminders; moves onto workflow deadlines and outbox ack in Phases 8-9',
  'external -> farmers': 'Fayda verification cache lives in farmer tables; split in Phase 2',
  'auth -> logistics': 'session revocation uses the logistics HotStateService (Redis); moves to a platform cache in Phase 10'
};

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('architecture', () => {
  it('modules match the target layout (Stage C: kebele-review → reviews, approvals → workflow, hierarchy → admin-units)', () => {
    const present = fs.readdirSync(MODULES);
    for (const retired of ['kebele-review', 'approvals', 'hierarchy']) expect(present).not.toContain(retired);
    for (const m of [...PLATFORM, ...DOMAIN]) expect(present).toContain(m);
    expect(present.filter(m => !PLATFORM.includes(m) && !DOMAIN.includes(m))).toEqual([]);
  });

  it('uploaded files never touch the local filesystem: no module imports fs (MinIO via StorageService only)', () => {
    const offenders = [...PLATFORM, ...DOMAIN]
      .flatMap(mod => tsFiles(path.join(MODULES, mod)))
      .filter(f => /from '(node:)?fs(\/promises)?'|require\('(node:)?fs'\)/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(MODULES, f));
    expect(offenders).toEqual([]);
  });

  it('platform modules never import domain modules (rule 2), apart from the listed debt', () => {
    const found = new Set<string>();
    for (const mod of PLATFORM) {
      for (const file of tsFiles(path.join(MODULES, mod))) {
        for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
          const target = path.relative(MODULES, path.resolve(path.dirname(file), spec)).split(path.sep)[0];
          if (DOMAIN.includes(target)) found.add(`${mod} -> ${target}`);
        }
      }
    }
    expect([...found].filter(v => !KNOWN_DEBT[v]).sort()).toEqual([]);
    // debt that has been paid off must be removed from the list
    expect(Object.keys(KNOWN_DEBT).filter(k => !found.has(k))).toEqual([]);
  });
});
