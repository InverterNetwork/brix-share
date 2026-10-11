# Brix Share

<a href="https://share.brix.money"><img align="right" width="140" height="140" src="./assets/logo-circle.svg" alt="Brix Share"></a>
*Zero-knowledge secret sharing for Brix. Paste a key, a password or a config, optionally attach files, and get two links: a share link for the recipient and a manage link for you. Everything is encrypted in your browser before it leaves; the server only ever stores ciphertext, hands it out as often as you allowed, then deletes it.*

**[share.brix.money](https://share.brix.money)** · [How it works](https://share.brix.money/how-it-works) · [Privacy](https://share.brix.money/privacy) · [Acceptable use](https://share.brix.money/acceptable-use)

- Design spec: [`docs/PLAN.md`](docs/PLAN.md). Design decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md). Operations: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- Contributing, rules and roadmap: [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: security@brix.money, see [`SECURITY.md`](SECURITY.md).

## What it does

- No accounts, no cookies, no analytics. Anyone can create a secret.
- A secret is an optional title, text up to 64 KB and up to 10 files (25 MB in total). Title, text, file names and file contents are encrypted.
- Access policy chosen at creation: burn after reading (default), up to 100 retrievals, or unlimited until expiry; expiry from about 6 minutes to 30 days (presets 1 hour to 30 days, default 7 days); optional "release later" date; optional passphrase for a second channel (a generated five-word phrase by default).
- The manage link shows status, every retrieval with time and country (never IP addresses) and lets you delete the secret at once. After a secret ends, a metadata-only history stays readable for 30 days.
- Link previews (Slack, Teams, mail scanners) do not consume anything: the secret is only retrieved when the recipient clicks "Reveal secret". Anything that sends the reveal request (a person, or a system that saw the link's path) uses up a retrieval, even without the key; the manage page shows when and from where.
- Works on desktop and phones, Brix branding, dark only.
- Use is subject to the [Acceptable use policy](https://share.brix.money/acceptable-use): reported or clearly illicit secrets are removed (by id, without the key; see the runbook).

## Goals

The service replaces vendor-held share links for secrets we send to and receive from partners, without trusting a third party with the content. The goals, in order:

1. The server never sees plaintext, file names or keys. A leak of the database, backups or logs reveals nothing.
2. Small enough to audit end to end (a few thousand lines, no crypto libraries, WebCrypto only).
3. One-time by default, exact view counting under concurrency, expiry enforced at retrieval time.
4. Honest about what it does not protect against (see [Security](#how-the-security-works)).
5. Runs in our own AWS account as infrastructure as code, serverless, and cheap at low volume.

## How the security works

### The protocol

1. The browser generates a random 16-byte id, a 32-byte link key `K_link` and a 32-byte manage token.
2. Without a passphrase, the data key is `K_link`. With one, `K_data = HKDF-SHA256(IKM = K_link, salt = PBKDF2-SHA256(NFC(trim(passphrase)), salt, 600 000), info = "brix-share/v1/passphrase")`, so the link alone is not enough.
3. Title, text and file metadata are encrypted as one JSON payload with AES-256-GCM (fresh 12-byte IV, 128-bit tag). The additional authenticated data binds protocol version, secret id and passphrase mode. Each file is encrypted separately with its own IV and AAD bound to secret id and file id.
4. The server receives the ciphertext envelope, the policy and `SHA-256(manage token)`. It never receives `K_link`, the passphrase or the token.
5. The share link is `https://<site>/s/<id>#<K_link>`, the manage link `https://<site>/m/<id>#<token>`. The part after `#` is never sent to any server; the page reads it once and removes it from the address bar. Keys live in memory only; the one exception is the manage token, which a manage page keeps in the tab's session storage so a reload works (browsers that restore closed tabs restore it too).
6. On load, the share page asks whether the secret can still be opened (a check that counts nothing). The recipient's browser then asks the server to release the envelope (the only call that counts as a retrieval), checks it belongs to the link, and decrypts. A wrong passphrase can be retried without a second retrieval.

Known-answer test vectors (`shared/vectors/kat-v1.json`) pin the protocol; they are checked against Node's crypto, RFC test vectors and the browser code in Chromium, Firefox and WebKit.

### On the server

- One-time and N-view limits are enforced by single conditional DynamoDB writes that re-check status, expiry, availability and the remaining count at write time. 50 parallel retrievals of a one-time secret yield exactly one success (tested). Writes are never retried by the SDK, so a lost response can burn at most the one retrieval it carried.
- A secret ends after its last retrieval, at expiry or on delete. The encrypted text is removed in the same write (at expiry: by the sweeper within about 5 minutes, or at once if someone opens the link). Encrypted files are deleted at once on delete, and otherwise by the sweeper 5 to 10 minutes after the end, so downloads that started just before the end can finish. The table has no backups, no point-in-time recovery and no streams, the files bucket no versioning, so ended secrets do not survive in copies.
- The API runs only behind CloudFront (the Lambda Function URL requires CloudFront's signature), with a WAF (rate limits per IP, a 128 KB body cap) and a proof-of-work on every create whose difficulty rises automatically under load; a circuit breaker can stop creation.
- No request bodies, tokens, ciphertext or presigned URLs are logged (tested). The database stores no IP addresses; recipients' countries come from CloudFront. CloudFront access logs (with IPs) are kept 30 days for abuse investigation and readable only by the admin role.
- Strict headers on every response: a Content Security Policy that allows only this site and the files bucket (no inline code, no eval), HSTS, no referrer, no framing, cross-origin isolation, no indexing.

### What it does not protect against

- **Whoever controls the web page.** Someone who can change the JavaScript the browser loads (our AWS account, our deploy process) could read secrets as they are typed or opened. We reduce this with reproducible builds, release manifests, a deploy role that is the only writer of the site, and an hourly external monitor that compares what is served with the release; it does not make it impossible. For custody or signing keys, encrypt to the recipient's verified public key first and use Brix Share only as transport.
- **A compromised backend and the access rules.** View limits, release dates, expiry and deletion are enforced by the server, not by cryptography. Someone in control of the backend could keep the ciphertext or release it again; they would still need the link key (and the passphrase, if set) to read it.
- **Retrievals used up by someone without the key.** Anyone who learns a link's path (`/s/<id>`, for example from logs of a chat or mail system) can use up its retrievals without being able to read it; the recipient then finds it gone. The manage page shows every retrieval with time and country; if one does not match, create a new secret.
- **Identity.** A link proves nothing about who sent or received it.
- **What the recipient does.** "One retrieval" means the server released the ciphertext once.
- **Weak passphrases.** Anyone holding the full link can guess passphrases offline; use the generated one.

The full threat model is PLAN section 4.

## Repository layout

pnpm workspace, Node 22 (`.nvmrc`):

| Path | What |
|---|---|
| `shared/` | Protocol constants, strict base64url, AAD builders, Zod schemas, request validation, manage-token hash, proof-of-work rules, known-answer vectors |
| `api/` | The single API Lambda: challenge, create, finalize, consume, status, delete; DynamoDB repository; S3 file store |
| `sweeper/` | 5-minute cleanup Lambda and the proof-of-work governor |
| `web/` | Vite + Preact + Tailwind app; all cryptography (`web/src/crypto`); Playwright suite and local test server (`web/e2e`) |
| `infra/` | CDK app: zone, edge (WAF, certificate) and main stacks; stage config format in `infra/stages.example.json` |
| `scripts/` | Release manifests, deploy scripts, live verification, log scrub, monitor |
| `design/` | Brand tokens and logos (reference) |
| `assets/` | README artwork |
| `docs/` | Design spec, decisions, runbook |

## Working on it

```sh
fnm use                 # Node 22
corepack enable         # pnpm from packageManager
pnpm install

pnpm lint               # ESLint (type-checked) + Prettier
pnpm typecheck
pnpm test               # Vitest everywhere; API and sweeper tests start DynamoDB Local in Docker
pnpm build              # web build (reproducible, SRI)
BRIX_SHARE_STAGES=infra/stages.example.json pnpm synth   # CDK synth with the example stage config, no AWS credentials
pnpm --filter @brix-share/web e2e   # Playwright in Chromium, Firefox, WebKit, Pixel 7, iPhone 14 (Docker)
```

Local app with a real API: `web/e2e/server.ts` serves the built site with production headers, routes `/api/*` into the real handler on DynamoDB Local, and fakes S3 on a second port. See `web/scripts/e2e-docker.sh` for how the suite starts it.

Rules that matter (details in [`CONTRIBUTING.md`](CONTRIBUTING.md)):
- No crypto libraries. Browser: WebCrypto. Server: `node:crypto` for hashing and HMAC.
- New dependencies need approval; versions are pinned exactly and pnpm keeps a 7-day release cooldown.
- Never log bodies, tokens, envelopes, ciphertext or presigned URLs.
- Existing known-answer vectors are frozen; changing the protocol means protocol `v2`.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, the Playwright suite, a build-twice reproducibility check and `cdk synth`. CI has no AWS credentials.

## Deploying

Deploys are manual, by an admin with an SSO session. Nothing deploys from CI. Full details and incident procedures: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

There is one stage, `prod`, in region eu-central-1, with the certificate and WAF in us-east-1:

| Stack | Region | Contents |
|---|---|---|
| `BrixShare-prod-zone` | us-east-1 | Route 53 zone `share.brix.money` |
| `BrixShare-prod-edge` | us-east-1 | WAF; ACM certificate once the custom domain is on |
| `BrixShare-prod` | eu-central-1 | Table, buckets, Lambdas, CloudFront, alarms, parameters, web deploy role |

### Prerequisites

`<prod-admin-profile>` is your own AWS CLI profile with admin access to the prod account (SSO or otherwise); `<prod-readonly-profile>` one with read-only access. Profile names are local to each machine, so the docs use placeholders.

```sh
aws sso login --profile <prod-admin-profile>
export AWS_PROFILE=<prod-admin-profile>
gh auth status          # deploy-web sets a repository variable, which needs admin rights
```

### 1. Infrastructure and API

```sh
git checkout main && git pull
scripts/deploy-infra.sh prod
```

The script refuses a dirty tree or a commit that is not on `origin/main` (the Lambda code is bundled from your checkout), shows `cdk diff`, asks, deploys zone, edge and main in that order, and records the deployed commit in the repository variable `DEPLOYED_INFRA_PROD`.

### 2. Web app

```sh
git tag vX.Y.Z && git push origin vX.Y.Z   # the release workflow builds twice and publishes manifest.json
git checkout vX.Y.Z
node scripts/deploy-web.ts prod vX.Y.Z --dry-run
node scripts/deploy-web.ts prod vX.Y.Z
```

`deploy-web.ts` rebuilds locally and refuses to deploy unless every file equals the release manifest CI published. It then assumes the web deploy role (the only principal allowed to write the site), uploads assets before `index.html` with explicit types and caching, invalidates the cache and records the release in `DEPLOYED_PROD` for the monitor.

### 3. Verify

```sh
node scripts/verify-live.ts prod <site url> vX.Y.Z
AWS_PROFILE=<prod-readonly-profile> node scripts/scrub-logs.ts prod /tmp/brix-verify-<run>.json
```

`verify-live` runs every flow against the live site with the real client crypto (create with proof-of-work, reveal, N views, release later, passphrase, files through the real bucket, delete, link-preview GET) and checks headers and every served file against the release. `scrub-logs` then proves none of the ids, tokens, keys or ciphertexts from that run appear in the logs.

### Stage config and first deploy

Account, domain, zone and alert routing are not in the repository. Maintainers keep them in the `STAGES_JSON` repository variable; the deploy scripts write it to the git-ignored `infra/stages.json` (format: `infra/stages.example.json`). Bringing up a new stage, from the CloudFront default domain to the custom domain, is described in the runbook.

### After a deploy

- The `monitor` workflow checks the live site hourly against the deployed release (files and headers) and alerts Slack if `SLACK_WEBHOOK_URL` is set.
- Alarms go to the stage's topic and to the topics in `alarmTopicArns` (prod: the team's alerts Slack channel); `alarmEmail` adds an e-mail subscription.
- Circuit breaker, proof-of-work difficulty, full purge, reading access logs: see the runbook.

## License

Copyright (C) 2026 Brix. The source code is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only): you may use, change and run it, including as a hosted service, as long as you publish your changes under the same licence.

Not covered by that licence:
- **The Brix brand.** The Brix name, the Brix and Brix Share logos (`assets/`, `design/brand/assets/`, the mark in `web/src/ui/shell.tsx`, `web/public/favicon.svg`) and the Brix visual identity belong to Brix and are not licensed for reuse. All rights reserved. A fork must remove them and use its own name and branding before it is deployed for others.
- **Fonts** in `web/src/assets/fonts` are third-party works under the SIL Open Font License; see `LICENSE.md` there.
