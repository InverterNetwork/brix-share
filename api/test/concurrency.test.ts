import { describe, expect, it } from 'vitest';
import { makeApi } from './harness.ts';

describe('concurrency (DynamoDB Local)', () => {
  it('50 parallel consumes of a one-time secret: exactly one 200', async () => {
    const api = await makeApi();
    const { id } = await api.create({ maxViews: 1 });
    const codes = await Promise.all(
      Array.from({ length: 50 }, () =>
        api.call('POST', `/api/secrets/${id}/consume`).then((r) => r.statusCode),
      ),
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 404)).toHaveLength(49);
  });

  it('50 parallel consumes of a 10-view secret: exactly ten 200s', async () => {
    const api = await makeApi();
    const { id, token } = await api.create({ maxViews: 10 });
    const codes = await Promise.all(
      Array.from({ length: 50 }, () =>
        api.call('POST', `/api/secrets/${id}/consume`).then((r) => r.statusCode),
      ),
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    const s = await api.call('GET', `/api/secrets/${id}/status`, {
      headers: { 'x-manage-token': token },
    });
    expect(s.json).toMatchObject({ status: 'ended', endedReason: 'consumed', viewsRemaining: 0 });
    expect((s.json!.retrievals as unknown[]).length).toBe(10);
  });

  it('delete racing consume on a one-time secret: never two successes, one end reason', async () => {
    const api = await makeApi();
    for (let i = 0; i < 20; i++) {
      const { id, token } = await api.create({ maxViews: 1 });
      const [c, d] = await Promise.all([
        api.call('POST', `/api/secrets/${id}/consume`).then((r) => r.statusCode),
        api
          .call('DELETE', `/api/secrets/${id}`, { headers: { 'x-manage-token': token } })
          .then((r) => r.statusCode),
      ]);
      expect([c, d].filter((x) => x === 200 || x === 204)).toHaveLength(1);
      const item = await api.repo.get(id);
      expect(item!.status).toBe('ended');
      expect(item!.endedReason).toBe(c === 200 ? 'consumed' : 'deleted');
    }
  });

  it('a lost consume response cannot be replayed: the retrieval is burnt', async () => {
    const api = await makeApi();
    const { id } = await api.create({ maxViews: 1 });
    await api.call('POST', `/api/secrets/${id}/consume`); // response "lost"
    expect((await api.call('POST', `/api/secrets/${id}/consume`)).statusCode).toBe(404);
  });
});
