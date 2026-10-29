import { seasonFromName, seasonStatusRelativeTo } from './season-calendar';

describe('season calendar', () => {
  it('parses the season names used in settings', () => {
    expect(seasonFromName('Meher 2026')).toEqual({
      id: 'MEHER-2026', name: 'Meher 2026', type: 'MEHER', year: 2026,
      startsOn: '2026-06-01', endsOn: '2026-12-31', collectionDeadline: '2026-03-31'
    });
    expect(seasonFromName('Belg 2026')).toMatchObject({ id: 'BELG-2026', collectionDeadline: '2025-11-30' });
    expect(seasonFromName('Irrigation 2026-27')).toMatchObject({
      id: 'IRRIGATION-2026', name: 'Irrigation 2026-27', year: 2026, startsOn: '2026-11-01', endsOn: '2027-04-30'
    });
  });

  it('rejects names it cannot place', () => {
    expect(seasonFromName('Summer 2026')).toBeNull();
    expect(seasonFromName('')).toBeNull();
  });

  it('derives status from the current season', () => {
    const meher = seasonFromName('Meher 2026')!;
    expect(seasonStatusRelativeTo(meher, meher)).toBe('OPEN');
    expect(seasonStatusRelativeTo(seasonFromName('Belg 2026')!, meher)).toBe('CLOSED');
    expect(seasonStatusRelativeTo(seasonFromName('Irrigation 2026-27')!, meher)).toBe('PLANNING');
  });
});
