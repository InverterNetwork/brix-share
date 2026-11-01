import { randomBytes } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HOUR, b64urlEncode, hashConsumeToken } from '@brix-share/shared';
import { describe, expect, it } from 'vitest';
import { makeApi } from './harness.ts';

const gone = {
  error: 'not_found',
  message: 'This secret does not exist or can no longer be opened.',
};

describe('consume capability', () => {
  it.each([1, 3, null])('gates availability and consume for maxViews=%s', async (maxViews) => {
    const api = await makeApi();
    const s = await api.create({ maxViews });
    expect(s.res.statusCode).toBe(201);
    expect((await api.repo.get(s.id))!.consumeTokenHash).toBe(
      await hashConsumeToken(s.consumeToken),
    );
    for (const token of [undefined, '', 'bad!', b64urlEncode(randomBytes(32)), s.token]) {
      for (const [method, path] of [
        ['GET', `/api/secrets/${s.id}`],
        ['POST', `/api/secrets/${s.id}/consume`],
      ]) {
        const r = await api.call(method!, path!, {
          authorize: false,
          headers: token === undefined ? {} : { 'x-consume-token': token },
        });
        expect(r.statusCode).toBe(404);
        expect(r.json).toEqual(gone);
      }
    }
    expect((await api.repo.get(s.id))!.retrievalCount).toBe(0);
    expect(
      (
        await api.call('GET', `/api/secrets/${s.id}`, {
          authorize: false,
          headers: { 'x-consume-token': s.consumeToken },
        })
      ).json,
    ).toEqual({ availableFrom: null });
    const r = await api.call('POST', `/api/secrets/${s.id}/consume`, {
      authorize: false,
      headers: { 'x-consume-token': s.consumeToken },
    });
    expect(r.statusCode).toBe(200);
    expect((await api.repo.get(s.id))!.retrievalCount).toBe(1);
    expect(JSON.stringify(r.json)).not.toContain(s.body.consumeTokenHash);
    expect(
      (
        await api.call('DELETE', `/api/secrets/${s.id}`, {
          headers: { 'x-manage-token': s.consumeToken },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects missing tokens before revealing a scheduled release time', async () => {
    const api = await makeApi();
    const s = await api.create({ availableIn: HOUR });
    expect((await api.call('GET', `/api/secrets/${s.id}`, { authorize: false })).json).toEqual(
      gone,
    );
    expect(
      (await api.call('POST', `/api/secrets/${s.id}/consume`, { authorize: false })).json,
    ).toEqual(gone);
    expect((await api.call('GET', `/api/secrets/${s.id}`)).json).toEqual({
      availableFrom: s.body.policy.availableFrom,
    });
    expect((await api.call('POST', `/api/secrets/${s.id}/consume`)).statusCode).toBe(425);
  });

  it('rejects historical items without a hash even with a valid token', async () => {
    const api = await makeApi();
    const s = await api.create();
    await api.db.send(
      new UpdateCommand({
        TableName: api.table,
        Key: { pk: `S#${s.id}` },
        UpdateExpression: 'REMOVE consumeTokenHash',
      }),
    );
    for (const authorize of [true, false]) {
      expect((await api.call('GET', `/api/secrets/${s.id}`, { authorize })).statusCode).toBe(404);
      expect(
        (await api.call('POST', `/api/secrets/${s.id}/consume`, { authorize })).statusCode,
      ).toBe(404);
    }
    expect((await api.repo.get(s.id))!.retrievalCount).toBe(0);
  });

  it.each([1, 3, null])(
    'rechecks the capability in the atomic write for maxViews=%s',
    async (maxViews) => {
      const api = await makeApi();
      const s = await api.create({ maxViews });
      let fired = false;
      api.clients.write.middlewareStack.add(
        (next, context) => async (args) => {
          if (context.commandName === 'UpdateItemCommand' && !fired) {
            fired = true;
            await api.db.send(
              new UpdateCommand({
                TableName: api.table,
                Key: { pk: `S#${s.id}` },
                UpdateExpression: 'SET consumeTokenHash = :h',
                ExpressionAttributeValues: {
                  ':h': await hashConsumeToken(b64urlEncode(randomBytes(32))),
                },
              }),
            );
          }
          return next(args);
        },
        { step: 'initialize', name: 'changeCapability' },
      );
      expect((await api.call('POST', `/api/secrets/${s.id}/consume`)).statusCode).toBe(404);
      expect(fired).toBe(true);
      expect((await api.repo.get(s.id))!.retrievalCount).toBe(0);
    },
  );
});
