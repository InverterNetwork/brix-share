import { cacheControl, contentType } from '../web/delivery.ts';

export interface Upload {
  path: string;
  key: string;
  contentType: string;
  cacheControl: string;
}

export interface DeployPlan {
  uploads: Upload[];
  /** Bucket keys to remove (on the versioned bucket this adds delete markers; versions stay). */
  deletes: string[];
}

/**
 * Upload order: hashed assets first, then other files, `index.html` last, so a browser that loads the new
 * index never finds its scripts missing. Files of the previous release stay one more release, so open tabs
 * can still load their lazily requested files (the PoW worker). Anything else in the bucket goes.
 */
export function planDeploy(
  current: Record<string, string>,
  previous: Record<string, string> | null,
  existingKeys: string[],
): DeployPlan {
  const paths = Object.keys(current).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const uploads = paths.map((path) => ({
    path,
    key: path.slice(1),
    contentType: contentType(path),
    cacheControl: cacheControl(path),
  }));
  const keep = new Set(
    [...Object.keys(current), ...Object.keys(previous ?? {})].map((p) => p.slice(1)),
  );
  const deletes = existingKeys.filter((k) => !keep.has(k)).sort();
  return { uploads, deletes };
}

function rank(path: string): number {
  if (path === '/index.html') return 2;
  if (path.startsWith('/assets/')) return 0;
  return 1;
}
