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

## Verify this site

Encryption happens in your browser: the code it loads decides whether your secret stays private. Brix Share is open source, its web build is reproducible, and every release publishes SHA-256 hashes of every served file on GitHub, with an artifact attestation signing the manifest. Anyone can rebuild the tag and compare with the manifest; that reproducibility is the underlying root of trust.

The release's `index.html` pins the entry script and stylesheet with Subresource Integrity hashes the browser enforces. All code that handles secrets is bundled into that script. **Every page path must return byte-identical `index.html`: check the exact URL you are about to use.** Checking `/index.html` alone cannot detect a different document served on share links. The expected hash must come from GitHub, never from the site being checked.

1. Read the version from the exact URL you are about to use: `/` for creating a secret, `/s/<id>` for revealing one, or `/m/<id>` for managing it. Remove the `#fragment` first: it contains the key or manage token and is never sent to the server. The version is a label, not proof.

```sh
# Use the exact URL you are about to use, without its #fragment.
url='https://share.brix.money/'
# For a share link, replace <id> with its actual id:
# url='https://share.brix.money/s/<id>'
# Copy your browser's user agent here (this is an example):
ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
curl -fsS --compressed -A "$ua" "$url" | grep brix-share-version
```

2. Confirm that the served version is [the latest release on GitHub](https://github.com/InverterNetwork/brix-share/releases/latest). An older legitimate release still passes its hash checks; if an older version is served live, something is wrong. Open `https://github.com/InverterNetwork/brix-share/releases/tag/<version>` and read `/index.html` in its hash table, or download the manifest and read that entry:

```sh
# Replace vX.Y.Z with the latest release confirmed on GitHub.
version=vX.Y.Z
curl -fL "https://github.com/InverterNetwork/brix-share/releases/download/$version/manifest.json" -o manifest.json
# Optional, with jq:
jq -r '.files["/index.html"]' manifest.json
```

3. Confirm that the release's full commit SHA is on `main`. Open `https://github.com/InverterNetwork/brix-share/commit/<sha>` and check the listed branches, or use the commands below in a clone. A tag name or an attestation alone does not establish that the code went through review.

```sh
# In a clone of InverterNetwork/brix-share; paste the full release commit from GitHub.
commit=FULL_RELEASE_COMMIT_SHA
git fetch origin main
git branch -r --contains "$commit"
# The output must include origin/main.
```

Optionally verify the manifest with the [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify). Check its reported commit against the release commit you just checked. The signer and source-ref restrictions check the workflow and tag name; they do not prove that the commit was reviewed or belongs to `main`:

```sh
gh attestation verify manifest.json -R InverterNetwork/brix-share
# Also constrain the signer and tag (recommended):
gh attestation verify manifest.json -R InverterNetwork/brix-share \
  --signer-workflow InverterNetwork/brix-share/.github/workflows/release.yml \
  --source-ref "refs/tags/$version"
```

The attestation establishes where this manifest came from and detects replacement with different bytes; it does not prove the source is safe. Older releases predating attestations do not have one.

4. Hash the response from that same exact URL on macOS or Linux. `--compressed` hashes the decompressed body, matching the manifest. Use your browser's user agent; response headers must show `Cache-Control: no-store`:

```sh
# Hash the same exact $url set above, without its #fragment.
curl -fsS --compressed -A "$ua" "$url" | shasum -a 256
# Linux:
curl -fsS --compressed -A "$ua" "$url" | sha256sum
# Response headers must show Cache-Control: no-store:
curl -fsSI --compressed -A "$ua" "$url" | grep -i '^cache-control:'
```

On Windows (PowerShell), use that same URL without the fragment:

```powershell
# Use the exact URL you are about to use, without its #fragment.
$url = 'https://share.brix.money/'
# For a share link: $url = 'https://share.brix.money/s/<id>'
Invoke-WebRequest $url -OutFile index.html
Get-FileHash index.html -Algorithm SHA256
```

Compare with the manifest's `/index.html` entry (hex case does not matter). Every path must return the same bytes. Equal hashes mean that response matches the release. This does not verify future loads, your browser or the server's access rules. Trust still depends on GitHub, the reviewed source and your own tools. If a hash differs, an older release is served or verification fails, **do not use the site**; report it to `security@brix.money`.

### The copy your browser received

A server could send curl the release but your browser a different document. Hashing the browser's original document response is stronger. “Save page as”, copying the DOM or copying view-source text can change bytes; do not treat those as the response.

Open DevTools' Network panel, load the exact URL without its `#fragment`, and export a HAR with response content as `browser.har`. Loading `/s/<id>` does not consume a retrieval; only clicking Reveal does. Select the document response, not an API response. Extract it without adding a newline and compare with the manifest's `/index.html` hash. The commands require exactly one matching response with content. Browser-menu exports have not been checked in every browser.

```sh
# Requires jq; use the same exact $url, without its #fragment.
# browser.har must contain exactly one response for that URL, with content.
jq -e --arg url "$url" '[.log.entries[] | select(.request.url == $url)] | length == 1 and (.[0].response.content.text | type == "string")' browser.har
jq -r --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.encoding // "text"' browser.har
# If encoding is "text":
jq -j --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.text' browser.har | shasum -a 256
# If encoding is "base64" (macOS and Linux):
jq -j --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.text' browser.har | base64 -d | shasum -a 256
```

Brix Share registers no service workers. In Chrome DevTools > Application > Service workers, there must be none for `share.brix.money`. If one is present, unregister it, reload and repeat the checks.

### Optional: check every file

This also checks the proof-of-work worker and static assets. Requires `jq` and bash; the subshell keeps shell options and failures local to this check:

```bash
# Requires jq and bash. Runs in a subshell so your shell stays unchanged.
(
  set -o pipefail
  base=https://share.brix.money
  ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  # Validate the manifest before the loop; failed downloads or hashes stop this check.
  jq -er '.files | to_entries[] | [.key, .value] | @tsv' manifest.json > /dev/null || exit 1
  while IFS=$'\t' read -r path expected; do
    actual=$(curl -fsS --compressed -A "$ua" "$base$path" | shasum -a 256) || exit 1
    actual=${}actual%% *}
    [ "$actual" = "$expected" ] || { echo "MISMATCH $path"; exit 1; }
    echo "OK $path"
  done < <(jq -r '.files | to_entries[] | [.key, .value] | @tsv' manifest.json)
)
```

The proof-of-work worker is outside the SRI chain (Workers cannot carry SRI); it receives no keys or secret content. For the highest-value keys, encrypt to the recipient's verified public key first and use Brix Share as transport.

The site's [/verify page](https://share.brix.money/verify) repeats these steps, but it could be tampered with too. This README on GitHub is the canonical copy; a “verified” badge from the page or backend would prove nothing against a changed frontend.

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

Setup, checks, dependency rules and workflow: [CONTRIBUTING.md](CONTRIBUTING.md). The local app and API test server are in `web/e2e/`; the Playwright suite runs in Docker.

## Deploying

Deploys are manual, by a maintainer with admin access. Nothing deploys from CI.
See [the deployment guide](docs/DEPLOYING.md) and [operations runbook](docs/RUNBOOK.md).

## License

Copyright (C) 2026 Brix. The source code is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only): you may use, change and run it, including as a hosted service, as long as you publish your changes under the same licence.

Not covered by that licence:
- **The Brix brand.** The Brix name, the Brix and Brix Share logos (`assets/`, `design/brand/assets/`, the mark in `web/src/ui/shell.tsx`, `web/public/favicon.svg`) and the Brix visual identity belong to Brix and are not licensed for reuse. All rights reserved. A fork must remove them and use its own name and branding before it is deployed for others.
- **Fonts** in `web/src/assets/fonts` are third-party works under the SIL Open Font License; see `LICENSE.md` there.
