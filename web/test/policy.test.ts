import { DAY, HOUR, MINUTE, isoToSec, validateCreateRequest } from '@brix-share/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FORM, checkPolicy, policyOf, type PolicyForm } from '../src/policy.ts';

const NOW = 1_800_000_000;
const form = (o: Partial<PolicyForm> = {}): PolicyForm => ({ ...DEFAULT_FORM, ...o });

/** A create body the shared server-side validator would accept, apart from the policy under test. */
function serverAccepts(policy: ReturnType<typeof policyOf>, serverNow: number) {
  const id = 'AAAAAAAAAAAAAAAAAAAAAA';
  return validateCreateRequest(
    {
      envelope: {
        v: 'v1',
        id,
        iv: 'AAAAAAAAAAAAAAAA',
        salt: null,
        ct: 'A'.repeat(64),
        hasPassphrase: false,
        fileIds: [],
      },
      policy,
      manageTokenHash: 'a'.repeat(64),
      consumeTokenHash: 'b'.repeat(64),
      pow: { challenge: 'c', nonce: '1' },
      files: [],
    },
    serverNow,
  ).ok;
}

describe('create policy', () => {
  it('defaults: burn after reading, 7 days, immediately', () => {
    expect(policyOf(form(), NOW)).toEqual({
      maxViews: 1,
      expiresAt: new Date((NOW + 7 * DAY) * 1000).toISOString(),
      availableFrom: null,
    });
    expect(checkPolicy(form(), NOW)).toBeNull();
  });

  it('every preset is accepted by the server even when it checks a minute later', () => {
    for (const expiry of ['1h', '1d', '7d', '14d', '30d'] as const) {
      const p = policyOf(form({ expiry }), NOW);
      expect(serverAccepts(p, NOW), expiry).toBe(true);
      expect(serverAccepts(p, NOW + 59), `${expiry} +59s`).toBe(true);
    }
    expect(isoToSec(policyOf(form({ expiry: '30d' }), NOW).expiresAt)).toBe(
      NOW + 30 * DAY - MINUTE,
    );
  });

  it('custom expiry bounds', () => {
    expect(checkPolicy(form({ expiry: 'custom', customExpiry: null }), NOW)).toMatch(/Pick/);
    expect(checkPolicy(form({ expiry: 'custom', customExpiry: NOW + 5 * MINUTE }), NOW)).toMatch(
      /6 minutes/,
    );
    expect(checkPolicy(form({ expiry: 'custom', customExpiry: NOW + 6 * MINUTE }), NOW)).toBeNull();
    expect(checkPolicy(form({ expiry: 'custom', customExpiry: NOW + 30 * DAY }), NOW)).toMatch(
      /30 days/,
    );
    const max = form({ expiry: 'custom', customExpiry: NOW + 30 * DAY - MINUTE });
    expect(checkPolicy(max, NOW)).toBeNull();
    expect(serverAccepts(policyOf(max, NOW), NOW + 30)).toBe(true);
  });

  it('views', () => {
    expect(policyOf(form({ views: 'unlimited' }), NOW).maxViews).toBeNull();
    expect(policyOf(form({ views: 'custom', customViews: 42 }), NOW).maxViews).toBe(42);
    expect(checkPolicy(form({ views: 'custom', customViews: 0 }), NOW)).toMatch(/between/);
    expect(checkPolicy(form({ views: 'custom', customViews: 101 }), NOW)).toMatch(/between/);
    expect(checkPolicy(form({ views: 'custom', customViews: 2.5 }), NOW)).toMatch(/between/);
  });

  it('release later must be in the future and well before expiry', () => {
    expect(checkPolicy(form({ releaseLater: true }), NOW)).toMatch(/release date/);
    expect(checkPolicy(form({ releaseLater: true, availableFrom: NOW }), NOW)).toMatch(/future/);
    const ok = form({ releaseLater: true, availableFrom: NOW + 2 * HOUR, expiry: '1d' });
    expect(checkPolicy(ok, NOW)).toBeNull();
    expect(serverAccepts(policyOf(ok, NOW), NOW + 30)).toBe(true);
    expect(
      checkPolicy(
        form({ releaseLater: true, availableFrom: NOW + HOUR - 5 * MINUTE, expiry: '1h' }),
        NOW,
      ),
    ).toMatch(/before the expiry/);
  });
});
