import { AuthUser } from '../types/auth-user';
import { containsUserUnit, inScope, pathWithin, scopeCondition, scopeUnitId } from './scope';

const ADAMA = { regionId: 'REG-OROMIA', zoneId: 'ZONE-OR-ESHEWA', woredaId: 'WOR-OR-ADAMA', kebeleId: null };
const user = (role: string, s: Partial<AuthUser>): AuthUser =>
  ({ id: 'U', name: 'U', email: null, phone: null, role, title: null, preferredLanguage: 'en', regionId: null, zoneId: null, woredaId: null, kebeleId: null, ...s }) as AuthUser;

const woreda = user('WOREDA', { ...ADAMA, adminUnitId: 'WOR-OR-ADAMA', unitPath: 'ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_ADAMA' });
const wonji = { ...ADAMA, kebeleId: 'KEB-01', path: 'ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_ADAMA.KEB_01' };
const lume = { regionId: 'REG-OROMIA', zoneId: 'ZONE-OR-ESHEWA', woredaId: 'WOR-OR-LUME', kebeleId: 'KEB-04', path: 'ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_LUME.KEB_04' };

describe('unified scope', () => {
  it('anchors each base role at the same level as before', () => {
    const s = { ...ADAMA, kebeleId: 'KEB-01' };
    expect(scopeUnitId('DA', s)).toBe('KEB-01');
    expect(scopeUnitId('WOREDA', s)).toBe('WOR-OR-ADAMA');
    expect(scopeUnitId('ZONE', s)).toBe('ZONE-OR-ESHEWA');
    expect(scopeUnitId('REGION', s)).toBe('REG-OROMIA');
    expect(scopeUnitId('DRIVER', {})).toBeNull();
  });

  it('pathWithin is ltree <@ (label boundaries respected)', () => {
    expect(pathWithin('ET.A.B', 'ET.A')).toBe(true);
    expect(pathWithin('ET.A', 'ET.A')).toBe(true);
    expect(pathWithin('ET.AB', 'ET.A')).toBe(false);
    expect(pathWithin('ET', 'ET.A')).toBe(false);
  });

  it('a record is in scope when its unit is inside the user unit (with or without paths)', () => {
    expect(inScope(woreda, wonji)).toBe(true);
    expect(inScope(woreda, lume)).toBe(false);
    const noPaths = ({ path, ...r }: any) => r;
    expect(inScope(woreda, noPaths(wonji))).toBe(true);
    expect(inScope(woreda, noPaths(lume))).toBe(false);
    expect(inScope(woreda, { regionId: 'REG-OROMIA' })).toBe(false);
    expect(inScope(user('MOA', {}), lume)).toBe(true);
    expect(inScope(user('DRIVER', {}), lume)).toBe(false);
  });

  it('falls back to the role rule when the principal has no adminUnitId', () => {
    const legacy = user('WOREDA', ADAMA);
    expect(inScope(legacy, { ...wonji, path: null })).toBe(true);
    expect(inScope(legacy, { ...lume, path: null })).toBe(false);
  });

  it('containsUserUnit: units at or above the user unit', () => {
    expect(containsUserUnit(woreda, { regionId: 'REG-OROMIA', path: 'ET.REG_OROMIA' })).toBe(true);
    expect(containsUserUnit(woreda, { regionId: 'REG-OROMIA' })).toBe(true);
    expect(containsUserUnit(woreda, { ...ADAMA })).toBe(true);
    expect(containsUserUnit(woreda, wonji)).toBe(false);
    expect(containsUserUnit(woreda, { ...wonji, path: null })).toBe(false);
    expect(containsUserUnit(woreda, { regionId: 'REG-AMHARA', path: 'ET.REG_AMHARA' })).toBe(false);
  });

  it('scopeCondition filters by the user unit subtree', () => {
    expect(scopeCondition(user('MOA', {}), 'f').sql).toBe('1=1');
    expect(scopeCondition(user('DRIVER', {}), 'f').sql).toBe('1=0');
    const s = scopeCondition(woreda, 'f', 'kebeleId');
    expect(s.sql).toContain('f.kebeleId IN (SELECT');
    expect(s.sql).toContain('<@');
    expect(s.params).toEqual({ scopeUnitId: 'WOR-OR-ADAMA' });
    expect(scopeCondition(woreda, 'a').sql).toContain('COALESCE(a.kebeleId, a.woredaId, a.zoneId, a.regionId)');
  });
});
