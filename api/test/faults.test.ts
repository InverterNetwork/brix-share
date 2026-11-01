import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HOUR } from '@brix-share/shared';
import { describe, expect, it } from 'vitest';
import { T0, makeApi } from './harness.ts';

type Api = Awaited<ReturnType<typeof makeApi>>;

/** Lets the next N UpdateItem calls commit in DynamoDB, then throws as if the response was lost. */
function loseUpdateResponses(api: Api, count: number) {
  let remaining = count;
  api.clients.write.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      if (context.commandName === 'UpdateItemCommand' && remaining > 0) {
        remaining--;
        const err = new Error('socket hang up');
        err.name = 'TimeoutError';
        throw err;
      }
      return result;
    },
    { step: 'deserialize', name: 'loseResponse', override: true },
  );
}

describe('fault injection', () => {
  it('a committed decrement with a lost DynamoDB response burns exactly one view (no SDK retry)', async () => {
    const api = await makeApi();
    const { id, token } = await api.create({ maxViews: 10 });
    loseUpdateResponses(api, 1);
    const r = await api.call('POST', `/api/secrets/${id}/consume`);
    expect(r.statusCode).toBe(500);
    const s = await api.call('GET', `/api/secrets/${id}/status`, {
      headers: { 'x-manage-token': token },
    });
    expect(s.json).toMatchObject({ viewsRemaining: 9, retrievalCount: 1 });
  });

  it('a committed final consume with a lost DynamoDB response ends the secret once', async () => {
    const api = await makeApi();
    const { id, token } = await api.create({ maxViews: 1 });
    loseUpdateResponses(api, 1);
    expect((await api.call('POST', `/api/secrets/${id}/consume`)).statusCode).toBe(500);
    expect((await api.call('POST', `/api/secrets/${id}/consume`)).statusCode).toBe(404);
    const s = await api.call('GET', `/api/secrets/${id}/status`, {
      headers: { 'x-manage-token': token },
    });
    expect(s.json).toMatchObject({ status: 'ended', endedReason: 'consumed', retrievalCount: 1 });
  });

  it('the write condition refuses a consume when the item expires between read and write', async () => {
    const api = await makeApi();
    const { id } = await api.create({ maxViews: null, lifetime: HOUR });
    // Right before the first UpdateItem is sent, move the stored expiry into the past. The read saw a live
    // item, so only the condition `expiresAt > :now` can stop this write.
    let fired = false;
    api.clients.write.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'UpdateItemCommand' && !fired) {
          fired = true;
          await api.db.send(
            new UpdateCommand({
              TableName: api.table,
              Key: { pk: `S#${id}` },
              UpdateExpression: 'SET expiresAt = :past',
              ExpressionAttributeValues: { ':past': T0 - 1 },
            }),
          );
        }
        return next(args);
      },
      { step: 'initialize', name: 'expireBeforeWrite', override: true },
    );
    const res = await api.repo.consume(
      id,
      () => T0,
      'DE',
      (await api.repo.get(id))!.consumeTokenHash,
    );
    expect(fired).toBe(true);
    expect(res.kind).toBe('not_found');
    const item = await api.repo.get(id);
    expect(item!.status).toBe('ended');
    expect(item!.retrievalCount).toBe(0);
  });

  it('50 parallel consumes of an unlimited secret crossing the 100-entry log cap all succeed and are all counted', async () => {
    const api = await makeApi();
    const { id, token } = await api.create({ maxViews: null });
    const seeded = Array.from({ length: 90 }, () => ({ at: T0, country: 'DE' }));
    await api.db.send(
      new UpdateCommand({
        TableName: api.table,
        Key: { pk: `S#${id}` },
        UpdateExpression: 'SET retrievals = :r, retrievalCount = :n',
        ExpressionAttributeValues: { ':r': seeded, ':n': 90 },
      }),
    );
    const codes = await Promise.all(
      Array.from({ length: 50 }, () =>
        api.call('POST', `/api/secrets/${id}/consume`).then((r) => r.statusCode),
      ),
    );
    const s = await api.call('GET', `/api/secrets/${id}/status`, {
      headers: { 'x-manage-token': token },
    });
    const ok = codes.filter((c) => c === 200).length;
    // The cap transition is the only way an unlimited append can fail; the re-read then takes the
    // no-append branch, which only fails if the secret ended. So every request succeeds.
    expect(ok).toBe(50);
    expect(s.json).toMatchObject({ retrievalCount: 90 + ok });
    expect((s.json!.retrievals as unknown[]).length).toBe(100);
  });
});
