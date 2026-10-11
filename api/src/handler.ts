import { SSMClient } from '@aws-sdk/client-ssm';
import { filesBucketOrigin } from '@brix-share/shared';
import { handle } from './app.ts';
import type { Deps } from './deps.ts';
import { Responder, type FunctionUrlEvent, type FunctionUrlResult } from './http.ts';
import { cachedParams, ssmStore } from './params.ts';
import { s3Store } from './files.ts';
import { Repo, documentClients } from './repo.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

let deps: Deps | undefined;

function init(): Deps {
  return {
    repo: new Repo(documentClients(), env('TABLE_NAME')),
    files: s3Store(env('FILES_BUCKET'), env('AWS_REGION')),
    params: cachedParams(ssmStore(new SSMClient({})), env('PARAM_PREFIX')),
    http: new Responder(filesBucketOrigin(env('FILES_BUCKET'), env('AWS_REGION'))),
    now: () => Math.floor(Date.now() / 1000),
  };
}

export function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  deps ??= init();
  return handle(deps, event);
}
