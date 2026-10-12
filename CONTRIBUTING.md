# Contributing to Brix Share

Brix Share is a zero-knowledge secret sharing service. Read [`docs/PLAN.md`](docs/PLAN.md) (the design spec) and [`docs/DECISIONS.md`](docs/DECISIONS.md) (every judgment call since) before changing anything that touches the protocol, the access semantics or the data model.

Security issues: report them to `security@brix.money`, not in a public issue.

## Setup

- Node 22, pinned in `.nvmrc` (for example `fnm use` or `nvm use`).
- pnpm via corepack: `corepack enable`, then `pnpm install`. The pnpm version comes from `packageManager` in `package.json`.
- Docker, for DynamoDB Local (API and sweeper tests) and the Playwright suite.

## Checks

Run these before opening a pull request. CI runs the same.

```sh
pnpm lint                                    # ESLint (type-checked) + Prettier check; `pnpm format` fixes formatting
pnpm typecheck
pnpm test                                    # Vitest in every package; API and sweeper tests start DynamoDB Local in Docker
pnpm build
BRIX_SHARE_STAGES=infra/stages.example.json pnpm synth   # CDK synth with the example stage config, no AWS credentials
pnpm --filter @brix-share/shared check-vectors   # fails if shared/vectors/kat-v1.json drifts from its generator
pnpm --filter @brix-share/web e2e            # Playwright in Chromium, Firefox, WebKit and two phone profiles (Docker)
```

Prettier does not format Markdown. Docs are written by hand; do not reflow them.

## Hard rules

- No crypto libraries. Browser: WebCrypto only. Server: `node:crypto` for hashing and HMAC only.
- Never log request bodies, manage tokens, envelopes, ciphertext or presigned URLs. Never put IP addresses in the table.
- Existing vectors in `shared/vectors/kat-v1.json` are frozen for protocol v1. New cases may be added; changing an existing one means a new protocol version. Fixed keys and IVs exist only in `shared/scripts/gen-vectors.ts`; real code always uses `crypto.getRandomValues`.
- The manage token travels in the `x-manage-token` header, never in a URL query string (`Authorization` is taken by CloudFront OAC signing).
- Imports use explicit `.ts` extensions (Node type stripping runs the CDK app and scripts directly).
- Stage config (accounts, domains, zones) is not in the repository: `infra/stages.json` is git-ignored and written from the `STAGES_JSON` repository variable; `infra/stages.example.json` shows the format and is what CI and the tests use.
- No secrets in the repository. The system has none by design (the proof-of-work HMAC key is generated at runtime in SSM); never commit anything that looks like one, and never print tokens from test runs into logs.

## Dependencies

New dependencies need maintainer approval before they are added. Say what the package is and why the standard library or an existing dependency does not do the job.

- Versions are pinned exactly (`saveExact: true` in `pnpm-workspace.yaml`).
- pnpm enforces a 7-day release cooldown (`minimumReleaseAge: 10080` in `pnpm-workspace.yaml`), so it holds in CI and on every machine.
- Build scripts are allowlisted in `pnpm-workspace.yaml` under `allowBuilds` (currently `esbuild` only). Keep the list minimal.
- Review the lockfile diff on every bump.

Approved and in use:

| Package | Where | Purpose |
|---|---|---|
| `typescript`, `@types/node` | root | language, Node types (types only) |
| `eslint`, `typescript-eslint` | root | linting |
| `prettier` | root | formatting |
| `vitest` | root | unit and integration tests |
| `zod` | shared | request and payload schemas |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | api, sweeper, web (dev) | DynamoDB |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | api, sweeper | files bucket, presigned URLs |
| `@aws-sdk/client-ssm` | api, sweeper | parameters (circuit breaker, difficulty, HMAC key) |
| `preact` | web | UI |
| `vite`, `tailwindcss`, `@tailwindcss/vite` | web | build and styles |
| `lucide-preact` | web | icons, bundled as inline SVG |
| `qrcode` | web | QR code for the share link, client-side only |
| `@playwright/test` | web | browser tests |
| `esbuild` | web, infra | bundling |
| `aws-cdk-lib`, `constructs`, `aws-cdk` | infra | infrastructure as code |

`actions/attest-build-provenance` is approved for signing release manifests in GitHub Actions (pinned by commit SHA). No runtime dependency.

Also pre-approved but unused: `@preact/preset-vite` (Vite's built-in JSX transform suffices), `lucide-static`. Types that would need extra packages (Lambda events, `qrcode`) are written by hand instead.

## Workflow

- Changes to `main` go through a pull request with one approval. No force pushes.
- Commit messages: `type(scope): description`, imperative.
- Record every judgment call in `docs/DECISIONS.md`: date, decision, reason. Changes to the crypto protocol, the access semantics, the data model, the security claims in `docs/PLAN.md` section 4 or the cost shape need explicit maintainer agreement first.
- Releases are `v*` tags on `main`. The release workflow builds twice, checks the builds are identical and publishes a manifest of every served file's SHA-256 on a GitHub release. Tags cannot be moved or deleted.
- Deploys are manual and done by a maintainer with admin access; nothing deploys from CI. See [the deployment guide](docs/DEPLOYING.md) and [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Roadmap

Planned protocol follow-ups (both backward compatible: new secrets use them, old secrets keep the current path until they expire within 30 days, then the fallback is removed):
- Per-file random keys carried inside the encrypted payload, so file objects that outlive a secret by a few minutes cannot be decrypted with a later-leaked link alone.
- A consume token derived from the link key and stored hashed, so someone who knows only a link's path cannot burn its retrievals or poll its availability.

Other:
- Candidates for a later version (`docs/PLAN.md` section 15): pinned offline client, secret request links, retrieval notifications, Argon2id as protocol `v2`.
