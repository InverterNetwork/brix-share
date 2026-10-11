/// <reference lib="webworker" />
import { solvePow } from './solver.ts';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<{ challenge: string; difficulty: number }>) => {
  const nonce = solvePow(e.data.challenge, e.data.difficulty, (tries) => {
    self.postMessage({ tries });
  });
  self.postMessage({ nonce });
};
