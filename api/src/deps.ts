import type { FileStore } from './files.ts';
import type { Responder } from './http.ts';
import type { Params } from './params.ts';
import type { Repo } from './repo.ts';

export interface Deps {
  repo: Repo;
  files: FileStore;
  params: Params;
  http: Responder;
  /** Epoch seconds. */
  now(): number;
}
