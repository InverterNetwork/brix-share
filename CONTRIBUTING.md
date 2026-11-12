# Contributing to Brix Share

Brix Share is a zero-knowledge secret sharing service. Read [`docs/PLAN.md`](docs/PLAN.md) (the design spec) and [`docs/DECISIONS.md`](docs/DECISIONS.md) (every judgment call since) before changing anything that touches the protocol, the access semantics or the data model.

Security issues: report them to `security@brix.money`, not in a public issue.

## Setup

- Node 24, pinned in `.nvmrc` (for example `fnm use` or `nvm use`).
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
- Never log request bodies, manage or consume tokens, envelopes, ciphertext or presigned URLs. Never put IP addresses in the table.
- Existing vectors in `shared/vectors/kat-v1.json` are frozen for protocol v1. New cases may be added; changing an existing one means a new protocol version. Fixed keys and IVs exist only in `shared/scripts/gen-vectors.ts`; real code always uses `crypto.getRandomValues`.
- The manage token travels in the `x-manage-token` header and the consume token in `x-consume-token`, never in a URL query string (`Authorization` is taken by CloudFront OAC signing).
- Imports use explicit `.ts` extensions (Node type stripping runs the CDK app and scripts directly).
- Stage config (accounts, domains, zones) is not in the repository: `infra/stages.json` is git-ignored and written from the `STAGES_JSON` repository variable; `infra/stages.example.json` shows the format and is what CI and the tests use.
- No secrets in the repository. The system has none by design (the proof-of-work HMAC key is generated at runtime in SSM); never commit anything that looks like one, and never print tokens from test runs into logs.

## Dependencies

New dependencies need maintainer approval before they are added. Say what the package is and why the standard library or an existing dependency does not do the job.

- Versions are pinned exactly (`saveExact: true` in `pnpm-workspace.yaml`).
- pnpm enforces a 7-day release cooldown (`minimumReleaseAge: 10080` in `pnpm-workspace.yaml`), so it holds in CI and on every machine.
- Build scripts are allowlisted in `pnpm-workspace.yaml` under `allowBuilds` (currently `esbuild` only). Keep the list minimal.
- Review the lockfile diff on every bump.
- AWS SDK packages (`@aws-sdk/*`) move together, and so do `tailwindcss` and `@tailwindcss/*`: same release, one lockfile resolution (see `docs/DECISIONS.md`, 2026-11-12).

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
| `@inverternetwork/platform-cdk` | infra | central alarm labels and routing |
| `aws-cdk-lib`, `constructs`, `aws-cdk` | infra | infrastructure as code |

`actions/attest-build-provenance` is approved for signing release manifests in GitHub Actions (pinned by commit SHA). No runtime dependency.

Also pre-approved but unused: `@preact/preset-vite` (Vite's built-in JSX transform suffices), `lucide-static`. Types that would need extra packages (Lambda events, `qrcode`) are written by hand instead.

## Workflow

- Changes to `main` go through a pull request with one approval. No force pushes.
- Commit messages: `type(scope): description`, imperative.
- Record every judgment call in `docs/DECISIONS.md`: date, decision, reason. Changes to the crypto protocol, the access semantics, the data model, the security claims in `docs/PLAN.md` section 4 or the cost shape need explicit maintainer agreement first.
- Releases are `v*` tags on `main`. The release workflow builds twice, checks the builds are identical and creates a draft GitHub release with an attested manifest of every served file's SHA-256. Complete and publish the notes before deployment, as described below. Tags cannot be moved or deleted.
- Deploys are manual and done by a maintainer with admin access; nothing deploys from CI. See [the deployment guide](docs/DEPLOYING.md) and [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Roadmap

- Candidates for a later version (`docs/PLAN.md` section 15): pinned offline client, secret request links, retrieval notifications, Argon2id as protocol `v2`.

Private package setup: follow the [platform-cdk setup guide](https://github.com/InverterNetwork/infra/tree/main/packages/platform-cdk#setup) before installing. The committed `.npmrc` contains only the registry scope. Export the package-read token through `NODE_AUTH_TOKEN`; never commit credentials. First-party package updates are exempt from the seven-day cooldown.

## Release notes

After pushing a `v*` tag on `main`, wait for the release workflow to succeed. It creates a draft release with `manifest.json` and a generated `### Verification` section. The release owner edits the draft in GitHub, adds human-written notes above that section, reviews them and publishes the release before deploying. Keep the generated verification text, collapsible File hashes (SHA-256) block, table and manifest unchanged. Draft assets are not publicly available for independent verification. The web deployment script refuses unpublished releases, including dry runs.

Read the actual changes since the previous release tag. Use this format for subsequent releases, omitting empty categories and replacing all placeholders:

```md
## 🚀 Production Release
**Last Commit:** [`<sha8>`](https://github.com/InverterNetwork/brix-share/tree/<full-tag-commit>)

### Added
- Describe the new behavior. ([#<pr>](https://github.com/InverterNetwork/brix-share/pull/<pr>))

### Changed
- Describe the behavior change, including compatibility and deployment requirements. ([#<pr>](https://github.com/InverterNetwork/brix-share/pull/<pr>))

### Fixed
- Describe the corrected behavior. ([#<pr>](https://github.com/InverterNetwork/brix-share/pull/<pr>))

### Maintenance
- Describe relevant tooling or operational work. ([#<pr>](https://github.com/InverterNetwork/brix-share/pull/<pr>))

**Full changelog:** [vA…vB](https://github.com/InverterNetwork/brix-share/compare/vA...vB)
```

Append the generated `### Verification` section last. It contains the build commit text and the hash table inside `<details>` with `<summary>File hashes (SHA-256)</summary>`; keep that markup intact. Resolve Last Commit from the tag's commit, including for annotated tags. End each change bullet with its PR link. For the first release, use `## 🚀 Initial Release`, the Last Commit link, a one-line product description and short themed sections describing the app at that tag; omit the previous-release comparison.
