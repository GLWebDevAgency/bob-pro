import { describe, expect, it } from 'vitest';
import { parseJobCabinetIds } from './env';

describe('configuration du worker Cabinet', () => {
  it('déduplique les cabinets sans changer leur ordre', () => {
    expect(parseJobCabinetIds('cab-a,cab-b,cab-a')).toEqual(['cab-a', 'cab-b']);
  });

  it('refuse un 101e cabinet distinct que le scheduler ne pourrait pas balayer', () => {
    const ids = Array.from({ length: 101 }, (_, index) => `cab-${index}`).join(',');
    expect(() => parseJobCabinetIds(ids)).toThrow(/100 cabinets/);
  });
});
