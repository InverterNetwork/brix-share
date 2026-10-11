import { randomBytes } from 'node:crypto';
import { b64urlEncode, DAY, HOUR } from '@brix-share/shared';
import { describe, expect, it, vi } from 'vitest';
import { handle } from '../src/app.ts';
import { solve } from '../src/pow.ts';
import { T0, makeApi } from './harness.ts';

describe('router contract with the WAF rules', () => {
  it('only exact, lower-case, unencoded paths reach a route', async () => {
    const api = await makeApi();
    const { id } = await api.create({ maxViews: 5 });
    for (const [m, p] of [
      ['POST', '/api/secrets/'],
      ['POST', '/API/secrets'],
      ['POST', '/api/Secrets'],
      ['POST', '/api/secret%73'],
      ['POST', `/api/secrets/${id}/consume/`],
      ['POST', `/api/secrets/${id}/CONSUME`],
      ['POST', `/api/secrets/${id}%2Fconsume`],
      ['POST', `/api/secrets/${id}/consume%20`],
      ['GET', '/api/challenge/'],
      ['POST', `//api/secrets/${id}/consume`],
    ] as const) {
      expect((await api.call(m, p)).statusCode, `${m} ${p}`).toBe(404);
    }
    expect((await api.call('POST', `/api/secrets/${id}/consume`)).statusCode).toBe(200);
  });
});

describe('tombstones', () => {
  it('no envelope on any tombstone kind; history TTL is endedAt + 30 d; counter keeps counting past the log cap', async () => {
    const api = await makeApi();
    const consumed = await api.create();
    await api.call('POST', `/api/secrets/${consumed.id}/consume`);
    const deleted = await api.create();
    await api.call('DELETE', `/api/secrets/${deleted.id}`, {
      headers: { 'x-manage-token': deleted.token },
    });
    const expired = await api.create({ lifetime: HOUR });
    api.clock.now = T0 + HOUR;
    await api.call('GET', `/api/secrets/${expired.id}/status`, {
      headers: { 'x-manage-token': expired.token },
    });
    for (const [s, reason, endedAt] of [
      [consumed, 'consumed', T0],
      [deleted, 'deleted', T0],
      [expired, 'expired', T0 + HOUR],
    ] as const) {
      const item = await api.repo.get(s.id);
      expect(item, reason).toMatchObject({
        status: 'ended',
        endedReason: reason,
        endedAt,
        purgeAt: endedAt + 30 * DAY,
      });
      expect(item!.envelope).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain(s.body.envelope.ct);
    }
    api.clock.now = T0;

    const unlimited = await api.create({ maxViews: null });
    for (let i = 0; i < 103; i++) await api.call('POST', `/api/secrets/${unlimited.id}/consume`);
    const st = await api.call('GET', `/api/secrets/${unlimited.id}/status`, {
      headers: { 'x-manage-token': unlimited.token },
    });
    expect(st.json).toMatchObject({ retrievalCount: 103 });
    expect((st.json!.retrievals as unknown[]).length).toBe(100);
  });

  it('status with a wrong token never writes, even on a stale item', async () => {
    const api = await makeApi();
    const s = await api.create({ lifetime: HOUR });
    api.clock.now = T0 + 2 * HOUR;
    await api.call('GET', `/api/secrets/${s.id}/status`, {
      headers: { 'x-manage-token': b64urlEncode(randomBytes(32)) },
    });
    expect((await api.repo.get(s.id))!.status).toBe('ready');
  });
});

describe('log hygiene', () => {
  it('no token, ciphertext, id or body ever reaches stdout, including on 500 and conditional failures', async () => {
    const lines: string[] = [];
    const capture = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      const api = await makeApi();
      const secrets = [];
      for (const maxViews of [1, 3, null]) secrets.push(await api.create({ maxViews }));
      for (const s of secrets) {
        await api.call('POST', `/api/secrets/${s.id}/consume`, {
          headers: { 'cloudfront-viewer-country': 'NL' },
        });
        await api.call('POST', `/api/secrets/${s.id}/consume`);
        await api.call('GET', `/api/secrets/${s.id}/status`, {
          headers: { 'x-manage-token': s.token },
        });
        await api.call('DELETE', `/api/secrets/${s.id}`, {
          headers: { 'x-manage-token': s.token },
        });
        await api.call('DELETE', `/api/secrets/${s.id}`, {
          headers: { 'x-manage-token': s.token },
        });
      }
      // Replay: conditional failure on the challenge put.
      expect((await api.call('POST', '/api/secrets', { body: secrets[0]!.body })).statusCode).toBe(
        400,
      );
      // Id conflict: fresh challenge, existing id, conditional failure on the secret put.
      const ch = await api.call('GET', '/api/challenge');
      const challenge = ch.json!.challenge as string;
      const conflict = await api.call('POST', '/api/secrets', {
        body: { ...secrets[0]!.body, pow: { challenge, nonce: solve(challenge, 8) } },
      });
      expect(conflict.statusCode).toBe(409);
      // Forced 500 with an error message that contains secret material.
      const s = secrets[1]!;
      const broken = {
        ...api.deps,
        repo: Object.assign(
          Object.create(Object.getPrototypeOf(api.repo) as object) as typeof api.repo,
          api.repo,
          {
            consume: () => Promise.reject(new Error(`boom ${s.token} ${s.body.envelope.ct}`)),
          },
        ),
      };
      const r = await handle(broken, {
        rawPath: `/api/secrets/${s.id}/consume`,
        requestContext: { http: { method: 'POST' } },
      });
      expect(r.statusCode).toBe(500);
      expect(r.body).not.toContain(s.token);

      const out = lines.join('');
      expect(out).toContain('"event":"request"');
      expect(out).toContain('"status":500');
      for (const sec of secrets) {
        for (const needle of [
          sec.token,
          sec.id,
          sec.body.envelope.ct,
          sec.body.manageTokenHash,
          sec.body.pow.challenge,
        ]) {
          expect(out).not.toContain(needle);
        }
      }
      for (const line of out.trim().split('\n'))
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      // Presigned URLs (from consume responses) never reach the logs.
      expect(out).not.toMatch(/token=|X-Amz-Signature|files\.test\.invalid/);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
