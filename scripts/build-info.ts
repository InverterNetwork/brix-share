/** One identity for HTML, the app, CI and the local deploy build. */
export function buildInfo(env: NodeJS.ProcessEnv): { version: string; commit: string } {
  const version = env.BRIX_SHARE_VERSION ?? 'dev';
  const commit = env.BRIX_SHARE_COMMIT ?? '';
  if (
    env.GITHUB_REF_TYPE === 'tag' &&
    env.GITHUB_REF_NAME?.startsWith('v') &&
    version !== env.GITHUB_REF_NAME
  )
    throw new Error('Release tag requires matching BRIX_SHARE_VERSION');
  if (version === 'dev') return { version, commit: 'dev' };
  if (!/^v[0-9][A-Za-z0-9._-]*$/.test(version) || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error('Release builds require a v-prefixed version and full lowercase commit SHA');
  return { version, commit: commit.slice(0, 7) };
}
