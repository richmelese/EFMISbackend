import { backoffMs } from './outbox.types';

describe('outbox back-off', () => {
  it('doubles from 30 s and caps at 6 h', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(30)).toBe(6 * 3_600_000);
  });
});
