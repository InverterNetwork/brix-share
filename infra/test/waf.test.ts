import { describe, expect, it } from 'vitest';
import { CONTENT_LENGTH_OVER_CAP_REGEX } from '../lib/waf.ts';

describe('Content-Length cap regex', () => {
  const re = new RegExp(CONTENT_LENGTH_OVER_CAP_REGEX);

  it('matches exactly the values above 131072', () => {
    for (let n = 0; n <= 1_200_000; n += n < 140_000 ? 1 : 997) {
      expect(re.test(String(n)), String(n)).toBe(n > 131072);
    }
    expect(re.test('131072')).toBe(false);
    expect(re.test('131073')).toBe(true);
    expect(re.test('1000000')).toBe(true);
    expect(re.test('99999999999')).toBe(true);
  });
});
