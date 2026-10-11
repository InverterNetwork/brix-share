export class PowCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PowCancelled';
  }
}

export interface PowJob {
  result: Promise<string>;
  cancel: () => void;
}

/** Solves a proof-of-work challenge in a module worker so the UI stays responsive. */
export function solveInWorker(
  challenge: string,
  difficulty: number,
  onProgress?: (tries: number) => void,
): PowJob {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let reject: (e: Error) => void = () => undefined;
  const result = new Promise<string>((res, rej) => {
    reject = rej;
    worker.onmessage = (e: MessageEvent<{ nonce?: string; tries?: number }>) => {
      if (e.data.nonce !== undefined) {
        worker.terminate();
        res(e.data.nonce);
      } else if (e.data.tries !== undefined) {
        onProgress?.(e.data.tries);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || 'proof-of-work worker failed'));
    };
  });
  worker.postMessage({ challenge, difficulty });
  return {
    result,
    cancel: () => {
      worker.terminate();
      reject(new PowCancelled());
    },
  };
}
