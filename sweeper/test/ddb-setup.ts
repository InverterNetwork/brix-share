/**
 * Vitest global setup: makes a DynamoDB Local endpoint available to tests via `inject('ddbEndpoint')`.
 * CI provides one as a service container; locally a throwaway Docker container is started.
 */
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    ddbEndpoint: string;
  }
}

const IMAGE =
  'amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab';

export default async function setup(project: TestProject): Promise<() => void> {
  if (process.env.DYNAMODB_ENDPOINT) {
    await waitReady(process.env.DYNAMODB_ENDPOINT, () => undefined);
    project.provide('ddbEndpoint', process.env.DYNAMODB_ENDPOINT);
    return () => undefined;
  }
  if (process.env.CI) throw new Error('DYNAMODB_ENDPOINT must be set in CI');
  const id = execFileSync(
    'docker',
    ['run', '-d', '--rm', '-p', '127.0.0.1::8000', IMAGE, '-jar', 'DynamoDBLocal.jar', '-inMemory'],
    {
      encoding: 'utf8',
    },
  ).trim();
  const port = execFileSync('docker', ['port', id, '8000/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .pop();
  const endpoint = `http://127.0.0.1:${port}`;
  await waitReady(endpoint, () => execFileSync('docker', ['rm', '-f', id]));
  project.provide('ddbEndpoint', endpoint);
  return () => {
    execFileSync('docker', ['rm', '-f', id]);
  };
}

async function waitReady(endpoint: string, cleanup: () => void): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(endpoint);
      return;
    } catch {
      if (Date.now() > deadline) {
        cleanup();
        throw new Error('DynamoDB Local did not become ready within 30 s');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
