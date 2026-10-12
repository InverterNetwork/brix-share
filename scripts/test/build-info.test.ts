import { describe, expect, it } from 'vitest';
import { buildInfo } from '../build-info.ts';

describe('build identity', () => {
  const commit = 'a'.repeat(40);
  it('defaults non-release builds to dev', () => {
    expect(buildInfo({})).toEqual({ version: 'dev', commit: 'dev' });
    expect(buildInfo({ BRIX_SHARE_VERSION: 'dev', BRIX_SHARE_COMMIT: commit })).toEqual({
      version: 'dev',
      commit: 'dev',
    });
  });
  it('uses a validated release and seven commit characters', () => {
    expect(buildInfo({ BRIX_SHARE_VERSION: 'v1.3.0', BRIX_SHARE_COMMIT: commit })).toEqual({
      version: 'v1.3.0',
      commit: 'aaaaaaa',
    });
  });
  it('fails closed for release tags and invalid identities', () => {
    expect(() => buildInfo({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.3.0' })).toThrow();
    for (const env of [
      { BRIX_SHARE_VERSION: 'v1.3.0' },
      { BRIX_SHARE_VERSION: 'v1.3.0', BRIX_SHARE_COMMIT: 'abc1234' },
      { BRIX_SHARE_VERSION: 'v1.3.0"<script>', BRIX_SHARE_COMMIT: commit },
      {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v1.3.0',
        BRIX_SHARE_VERSION: 'v1.2.0',
        BRIX_SHARE_COMMIT: commit,
      },
    ])
      expect(() => buildInfo(env)).toThrow();
  });
});
