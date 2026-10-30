import { objectKey, retentionUntil } from './storage.types';

describe('storage keys and retention', () => {
  it('builds keys from generated parts only', () => {
    expect(objectKey('FARM-2026-00012', 'DOC-AB12.jpg')).toBe('FARM-2026-00012/DOC-AB12.jpg');
    expect(objectKey('6f1c2a7e-0b1d-4c55-9a6e-1f2d3c4b5a69', 'licence-demo.pdf')).toBe('6f1c2a7e-0b1d-4c55-9a6e-1f2d3c4b5a69/licence-demo.pdf');
  });

  it.each([['..'], ['../etc'], ['a/b'], [''], ['.hidden'], ['a\\b'], ['x'.repeat(200)], ['a..b']])('rejects segment %j', bad => {
    expect(() => objectKey('FARM-1', bad)).toThrow(/Invalid object key segment/);
  });

  it('keeps farmer documents and delivery proofs 7 years, driver documents until expiry + 2 years', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const years = (d: Date) => Math.round(((d.getTime() - now.getTime()) / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
    expect(years(retentionUntil('FARMER_DOCUMENTS', now))).toBe(7);
    expect(years(retentionUntil('DELIVERY_PROOFS', now))).toBe(7);
    expect(years(retentionUntil('DRIVER_DOCUMENTS', now, '2029-10-30'))).toBe(5);
    expect(years(retentionUntil('DRIVER_DOCUMENTS', now, null))).toBe(7);
    // an already expired document is still kept 2 years from now
    expect(years(retentionUntil('DRIVER_DOCUMENTS', now, '2020-01-01'))).toBe(2);
  });
});
