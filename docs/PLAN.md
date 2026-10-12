# Brix Share: Plan

Status: design spec for protocol v1, written 2026-10-09 and implemented; live at `share.brix.money`. Inline notes mark where the implementation differs; the reasons are in `docs/DECISIONS.md`.
Name and domain are final: Brix Share at `share.brix.money`.

## 1. Summary and recommendation

Build a small, purpose-built, zero-knowledge secret sharing service, inspired by Hemmelig.app's feature set and UX, hosted as its own CDK stack in Brix's production AWS account. Do not adopt and rebrand an existing tool.

Why build: no maintained open-source tool meets the full requirement set (client-side encryption, anonymous creation, one-time by default, N views, expiry date, release later, creator delete link, files, Brix branding). The closest match, Hemmelig, archived its repository on 2026-10-05 under a restrictive license. The server side is small (store a blob, hand it out N times, delete it). The crypto is a textbook WebCrypto AES-256-GCM envelope with the key in the URL fragment. Owning roughly 2k to 3k lines we can audit end to end beats auditing every release of a general-purpose app with accounts, admin panels and 30 environment variables.

Tradeoff: we own the security review and maintenance. Mitigation: this spec, WebCrypto-only primitives with zero crypto dependencies, a versioned protocol, adversarial security reviews plus teammate review before go-live, a named maintainer.

Fallback if building is rejected: PrivateBin (mature zero-knowledge design, delete token, burn-after-reading with confirm step), accepting no "N views", no release later, and a PHP stack.

## 2. Requirements

Must have (v1):
- Publicly reachable web UI, no accounts, no cookies. Anyone can create a share (we send to externals, externals send to us).
- Secret = optional title + raw text (up to 64 KB UTF-8) + optional file attachments (total 25 MB). Title and text are encrypted; file names and contents are encrypted.
- Server never sees plaintext, file names or keys. Encryption and decryption happen in the browser.
- Access policy, chosen at creation (modeled on Hemmelig):
  - Burn after reading (max views 1), the default.
  - Max views 1 to 100, or unlimited until expiry.
  - Expires after: 1 hour, 1 day, 7 days (default), 14 days, 30 days (hard cap), or a custom date within the cap. "Until deleted" means until the cap, and the UI says so.
  - Release later: optional "available from" date and time. Before it, the secret cannot be retrieved. Expiry still counts from creation.
  - Optional passphrase, off by default. Extra layer for highly sensitive secrets: a second secret the sender passes over a second channel (call, Signal), so the link alone is not enough. When switched on, the UI proposes a generated passphrase.
- Creator receives two links: the share link (recipient) and a manage link (status, retrieval log with timestamps and country, delete). Deleting removes ciphertext and files from the server immediately.
- After a secret ends (last view, expiry, or deletion) the manage link keeps showing a metadata-only history (created, policy, retrievals, how and when it ended) for 30 days after that final event. No ciphertext is retained.
- Link previews (Slack, Telegram, Teams, mail scanners) must not consume a view. No URL splitting needed.
- Brix branding from the Brix Design System (section 10), dark mode only in v1. Clean two-column form like Hemmelig: content on the left, options on the right.
- Runs in our AWS infrastructure, deployed with CDK, infrastructure as code only.

Phasing inside v1: text secrets first (steps 1 to 5 in section 17), files as the last phase.

Not in v1 (section 15): secret request links, pinned offline client, retrieval notifications, IP allowlists, SSO for higher internal quotas, Argon2id.

## 3. Existing tools considered

| Tool | Zero-knowledge | One-time | N views | Expiry date | Release later | Creator delete | Anonymous create | Files | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Hemmelig.app | yes (TweetNaCl) | yes | yes | yes | yes | authenticated only (anon unclear) | yes | authenticated only | Repo archived 2026-10-05, O'Saasy license on v7. UX reference only. |
| PrivateBin | yes (AES-256-GCM, PBKDF2 100k) | yes, confirm step | no | yes | no | yes (delete token) | yes | yes | Best fallback. |
| Yopass | yes (OpenPGP.js) | yes | no (OSS) | 1h/1d/1w | no | no | yes | yes | Fork needed. |
| Cryptgeon | yes (XChaCha20-Poly1305) | yes | yes | minutes | no | no | yes | yes | No delete link, no passphrase, view-count race across instances. |
| Password Pusher | no (server-side) | yes | yes | yes | no | yes | yes | yes | Not zero-knowledge. Out. |
| Vaultwarden Send | yes | yes | yes | yes | no | yes | no | yes | Needs account to create. Out. |
| 1Password share links (status quo) | vendor-held | yes | yes | yes | no | yes | no | yes | Third party holds the data. |

## 4. Threat model and the security claim we can honestly make

Protects against:
- Database, backup or log leak: the server only holds ciphertext, IVs, salts and policy metadata.
- Backend or infrastructure compromise that cannot alter what the browser loads (Lambda, DynamoDB, S3 data plane, IAM, cloud provider staff with data-plane access): ciphertext only.
- Link leakage after consumption: a burn-after-reading link is dead after the first retrieval. A leaked multi-view link is covered by the optional passphrase.
- Link preview fetchers: the GET for the page consumes nothing. Retrieval requires an explicit click that issues a POST. Previewers fetch and sometimes render, but do not click buttons or issue POSTs. Residual: a scanner that executes JavaScript and synthesizes clicks; the manage page shows retrieval timestamps and countries so the sender can spot an unexpected consumption and recreate the secret. Availability and retrieval requests require a consume token derived from the link key, so path-only observers cannot poll availability or burn retrievals.
- Guessing: 128-bit random IDs, 256-bit random keys, 256-bit random manage tokens.

Does not protect against (stated in the docs and the about page):
- A compromised frontend delivery (S3 static bucket, CloudFront, deploy pipeline, or anyone with admin in the hosting account). Malicious JavaScript can read plaintext at creation or the key at reveal. SRI and CSP do not fix this when the attacker controls HTML and headers. Section 11 reduces likelihood and improves detection. For custody or production signing keys use the pinned client (section 15) at both ends, or pre-encrypt to the recipient's verified public key and use the service as transport only.
- Identity: possession of a link is not proof of who sent or received it. For consequential exchanges verify identity and key fingerprints over an independent channel.
- Recipient behaviour: "N retrievals" means N times the server released the ciphertext, not N reads by N humans.
- Offline passphrase guessing by someone who holds the full link and the ciphertext; addressed by KDF cost and generated passphrases (section 6), not eliminated for weak user-chosen passphrases.

## 5. Architecture (AWS, serverless)

One CDK app, stack `BrixShare-<stage>`, parameterized by stage; only `prod` (eu-central-1) is deployed. Stage specifics (account, domain, alert routing) are not in the repository: maintainers keep them in a repository variable, and `infra/stages.example.json` shows the format. The stack is self-contained and shares nothing with other stacks. Deploys are manual (2026-10-09): infra and API by an admin with `cdk deploy`, the static frontend through a dedicated web deploy role, the only principal the static bucket accepts writes from. CI holds no AWS credentials. CloudFront needs its certificate and WAF in us-east-1, so a stage is a main stack in eu-central-1 plus an edge stack and the prod zone stack in us-east-1 (see DECISIONS.md).

Components:
- DNS and certificates. The parent domain is not in Route 53. The stack creates a Route 53 hosted zone for the service's domain, which is delegated once from the parent (four NS records); after that CDK owns the records and ACM DNS validation. Until the delegation exists the site runs on the CloudFront default domain (`*.cloudfront.net`); the `customDomain` switch in the stage config then adds the ACM certificate (us-east-1, DNS-validated), the alias and the Route 53 records.
- CloudFront distribution, one origin set:
  - `/api/*` → Lambda Function URL, origin access control (OAC) with IAM signing, so the function URL cannot be called except through CloudFront.
  - everything else → S3 static bucket, OAC, bucket private.
- AWS WAF web ACL on CloudFront: rate-based rules (section 12), AWS managed common rule set, body size constraint, geo rules off. WAF attaches here because HTTP APIs do not support WAF directly and a CloudFront-only entry point has no bypass path.
- Lambda `api` (Node 22, TypeScript, single function, minimal router), 256 MB, reserved concurrency as a hard cap (section 12).
- DynamoDB table `secrets`, on-demand, TTL on `purgeAt` (see section 8), point-in-time recovery OFF, backups OFF, streams OFF, table deletion protection ON. Ephemeral data must not survive in historical copies.
- S3 bucket `files` (name ends in a random per-stage suffix so it does not reveal the account id; private, SSE-S3, versioning OFF, object lock OFF, no replication), lifecycle rule expiring all objects after 31 days as backstop. Uploads and downloads via presigned URLs issued by the Lambda; CORS on the bucket limited to the site origin, PUT and GET only.
- Lambda `sweeper` on a 5-minute EventBridge schedule (hourly in the original plan, see DECISIONS.md): tombstones expired secrets and deletes due or orphaned file objects (section 9.6). Reads only the sparse `sweep-due` GSI, not the table.
- SSM parameters: `createEnabled` (circuit breaker), `powDifficulty` (adaptive proof-of-work), `ipHashKey` not used (no IP storage, section 12).
- CloudWatch logs, 14-day retention, structured events without bodies, headers, tokens or ciphertext. No X-Ray payload tracing.
- CloudWatch alarms: 5xx rate, creates per hour, consumes per hour, table item count, bucket size, Lambda throttles, estimated charges. Create-rate alarm raises `powDifficulty`; sustained alarm flips `createEnabled`.

Alternative considered: Fargate container. Rejected: adds host and runtime operations and buys nothing for the client-side encryption or JS integrity, which are the actual risks.

Region: eu-central-1 only. Consume authority is single-writer; no global tables, no replication.

## 6. Cryptographic protocol (v1)

All client-side, WebCrypto only. No crypto libraries in the bundle. Protocol version string `v1` is stored with every secret and bound into the AAD so the client refuses mismatched envelopes.

Identifiers and keys (all from `crypto.getRandomValues`):
- `id`: 16 random bytes, base64url (22 chars). Client-chosen, server accepts only if unused (conditional put). Independent of the key.
- `K_link`: 32 random bytes. Carried only in the share URL fragment, base64url (43 chars).
- `T_consume`: 32 bytes derived from `K_link` (below); server stores `SHA-256(T_consume)` as hex. Authorizes availability and retrieval, independently of the passphrase.
- `T_manage`: 32 random bytes. Carried only in the manage URL fragment. Server stores `SHA-256(T_manage)` as hex.
- `salt`: 16 random bytes, present only if a passphrase is used.
- One fresh 12-byte IV per encryption call (text envelope, each file). Each IV is used once under `K_data`.

Key derivation:
```
Always:
  T_consume = HKDF-SHA256(IKM = K_link, salt = empty, info = "brix-share/v1/consume", 32 bytes)

Without passphrase:
  K_data = K_link

With passphrase:
  P      = PBKDF2-HMAC-SHA256(UTF-8(NFC(trim(passphrase))), salt, 600000 iterations, 32 bytes)
           (trim = ECMAScript String.prototype.trim; added 2026-10-09, see DECISIONS.md)
  K_data = HKDF-SHA256(IKM = K_link, salt = P, info = "brix-share/v1/passphrase", 32 bytes)
```
Rationale: someone holding the full link and the ciphertext can test passphrase guesses offline and verify them with the GCM tag, so the passphrase KDF must be expensive regardless of the 256 bits in `K_link`. PBKDF2 at 600k iterations is the WebCrypto-native option but GPU-friendly, so the UI generates the passphrase by default (5 words from the EFF short wordlist, about 64 bits; implemented with the EFF large wordlist, which is what delivers about 64 bits, see DECISIONS.md) and shows a strength meter plus warning if the user replaces it. Argon2id (memory-hard, OWASP preferred) would allow weak user-chosen passphrases but needs a WASM dependency and a CSP relaxation; deferred to protocol v2 (decision 5).

Text envelope:
```
AAD_text   = UTF-8("brix-share/v1|" + id + "|text|" + (passphrase ? "p" : "n"))
payload    = JSON { title: string | null, text: string, files: [{ fileId, name, size, mime }] }
ct_text    = AES-256-GCM(K_data, iv_text, UTF-8(JSON(payload)), AAD_text, tagLength 128)
```
File envelope, one per attachment:
```
AAD_file   = UTF-8("brix-share/v1|" + id + "|file|" + fileId)
ct_file    = AES-256-GCM(K_data, iv_file, fileBytes, AAD_file, tagLength 128)
stored as  = iv_file (12 bytes) || ct_file   in S3 object key  <id>/<fileId>
```
Files are encrypted whole in memory (25 MB total cap keeps this simple; GCM's limit is far higher). File names and MIME types live only inside the encrypted text payload; S3 sees opaque keys and sizes.

Policy metadata (views, expiry, availableFrom) is not inside the AAD: the server must enforce it and it is not secret. The recipient sees it as information only.

Envelope stored in DynamoDB (JSON string):
```
{ v: "v1", id, iv: b64url, salt: b64url | null, ct: b64url, hasPassphrase: bool, fileIds: [string] }
```
Plaintext, `K_link` and `K_data` never leave the browser. The client strips the fragment via `history.replaceState` after reading it and keeps keys only in memory. Nothing is written to localStorage, sessionStorage or IndexedDB. (Exception since v1.1, see DECISIONS.md 2026-10-10: an open manage page keeps its manage token in that tab's sessionStorage so a reload works; browsers that restore closed tabs restore it too. Share-link keys stay in memory only.)

Decryption failure (wrong passphrase or tampering) is reported as such; the retrieved envelope stays in memory so the recipient can retry the passphrase without a second consume.

Rendering: title and text go into text nodes or a readonly textarea. Never HTML, Markdown, auto-linking, or a page title derived from the secret. File names are rendered as text; downloads use a Blob URL with the decrypted name and `Content-Disposition` semantics handled client-side.

Known-answer test vectors for text and file envelopes are committed to the repo.

## 7. API

All under `/api`, JSON, `Cache-Control: no-store`, same-origin only (no CORS). Request body limit 128 KB enforced in WAF and Lambda. Unknown routes and methods return 404.

`GET /api/challenge`
- returns `{ challenge, difficulty, expiresAt }`. `challenge` = HMAC-signed random value with timestamp, valid 10 minutes. `difficulty` from SSM (default 18 leading zero bits, roughly 0.3 to 1 s in a browser).

`POST /api/secrets`
- body: `{ envelope, policy: { maxViews: number | null, expiresAt: ISO-8601, availableFrom: ISO-8601 | null }, manageTokenHash: hex, consumeTokenHash: hex, pow: { challenge, nonce }, files: [{ fileId, size }] }`
- validation: `v == "v1"`; id format; `ct` <= 96 KB encoded; `iv` 12 bytes; `salt` 16 bytes or null; `maxViews` null or 1..100; `expiresAt` in (now + 5 min, now + 30 d]; `availableFrom` null or in [now, expiresAt - 5 min); hash 64 hex; pow valid and unused (challenge replay blocked by a 10-minute conditional put of the challenge hash into the table); files 0..10, total size <= 25 MB, `fileIds` in envelope match.
- `createEnabled == false` → 503 with a friendly message.
- conditional put on `attribute_not_exists(id)`; 409 on collision (client regenerates).
- response 201: `{ id, expiresAt, availableFrom, maxViews, uploads: [{ fileId, url, headers }] }` where each `url` is a presigned S3 PUT valid 15 minutes, `Content-Length` pinned to `size + 28` (IV + tag), key `<id>/<fileId>`. The item is created with `status: "pending"` if files exist.

`POST /api/secrets/{id}/finalize` with header `Authorization: Bearer <T_manage>` (implemented as `x-manage-token`, see DECISIONS.md)
- Only for secrets with files. Server HEADs each object, checks sizes, sets `status: "ready"`. Until then consume returns 404. Pending items older than 1 hour are cleaned by the sweeper.

`POST /api/secrets/{id}/consume`
- no body; requires `x-consume-token: base64url(T_consume)`. The only call that counts as a retrieval.
- server: conditional update or delete (section 9). Success returns `{ envelope, policy: { viewsRemaining, expiresAt }, downloads: [{ fileId, url }] }` with presigned S3 GET URLs valid 2 minutes. The delete-token hash and internal attributes are never returned.
- `availableFrom > now` → 425 Too Early with `{ availableFrom }`. Everything else that is not retrievable → 404 (unknown, consumed, expired, deleted, pending), indistinguishable to the caller.
- The client never auto-retries. A committed consume with a lost response burns the retrieval; the UI explains this and tells the recipient to ask for a new link.

`GET /api/secrets/{id}/status` with header `Authorization: Bearer <T_manage>` (implemented as `x-manage-token`, see DECISIONS.md)
- returns `{ exists, status, viewsRemaining, maxViews, expiresAt, availableFrom, createdAt, retrievals: [{ at, country }] }`; 404 if the token hash does not match or the item is gone. Does not consume.
- After the final consume, expiry or deletion the item becomes a tombstone (section 9.7): `status: "ended"`, `endedAt`, `endedReason` (`consumed` | `expired` | `deleted`), full `retrievals` list, no envelope. The manage page shows the full history. Tombstones expire 30 days after `endedAt`.

`DELETE /api/secrets/{id}` with header `Authorization: Bearer <T_manage>` (implemented as `x-manage-token`, see DECISIONS.md)
- conditional delete on `deleteTokenHash == SHA-256(token)`; also deletes `<id>/*` from S3. 204 on success, 404 otherwise.

Tokens travel only in `x-manage-token` and `x-consume-token` headers, never in the query string and never logged. CloudFront OAC owns `Authorization`. Both availability and consume hash the decoded consume token with the shared helper and compare using `timingSafeEqual`; a missing, malformed or wrong token returns the same 404 as a missing secret.

`GET /api/secrets/{id}` (added in v1.1, see DECISIONS.md 2026-10-10)
- requires `x-consume-token: base64url(T_consume)`, counts nothing. 200 `{ availableFrom }` (null once released) if the secret can be opened now or later; otherwise the same 404 as consume. Never returns the envelope. The share page calls it on load.

`GET /api/health` returns 200 with no details.

## 8. Data model (DynamoDB)

Table `secrets`, partition key `pk` (string). Two item kinds share the table: `S#<id>` secrets and `C#<challengeHash>` consumed proof-of-work challenges (TTL 10 minutes).

Secret item:

| attribute | type | notes |
|---|---|---|
| pk | S | `S#<id>` |
| v | S | protocol version |
| status | S | `pending`, `ready` or `ended` |
| endedAt | N or NULL | epoch seconds, tombstones only |
| endedReason | S or NULL | `consumed`, `expired` or `deleted` |
| envelope | S or absent | JSON from section 6, up to about 100 KB; removed on tombstone |
| hasPassphrase | BOOL | for status without parsing |
| maxViews | N or NULL | null = unlimited until expiry |
| viewsRemaining | N or NULL | |
| retrievals | L | list of `{ at: N, country: S }`, max 100 entries |
| availableFrom | N or NULL | epoch seconds |
| expiresAt | N | epoch seconds; the policy expiry (live items and tombstones) |
| purgeAt | N | epoch seconds; DynamoDB TTL attribute. Live items: policy expiry + 30 d (TTL never removes a live item before the sweeper tombstones it). Tombstones: `endedAt + 30 d` (implementation correction 2026-10-09, see DECISIONS.md) |
| createdAt | N | epoch seconds |
| deleteTokenHash | S | hex SHA-256 of the manage token |
| consumeTokenHash | S | hex SHA-256 of the consume token; required |
| fileIds | L | list of strings, may be empty |
| sweepPart, sweepAt | S, N | sparse GSI keys: `live` + expiry (or pending cleanup time) for live items; `files` + `endedAt + 5 min` for ended items whose objects are due; absent when nothing is left to do (replaces `hasFiles`) |

GSI `sweep-due`: partition key `sweepPart`, sort key `sweepAt`. Sparse. Used by the sweeper to find live secrets due for expiry (with or without files), stale pending items and ended secrets whose files are due, without scanning. No other indexes. (Originally `files-by-expiry` on file-bearing items only; that left unread text-only secrets to TTL, which deleted them before they became tombstones and lost their history.)

No IP addresses anywhere in the table (section 12). `country` comes from the `CloudFront-Viewer-Country` header; country alone is not personal data.

## 9. Access semantics

9.1 Consume on `POST /api/secrets/{id}/consume`, `now` server-side:
1. Read the item and verify the consume token before disclosing availability or writing. Missing hash or invalid token → 404. Missing, `status != ready`, or `expiresAt <= now` → 404. `availableFrom > now` → 425.
2. If `viewsRemaining == 1`: `UpdateItem` that turns the item into a tombstone in one write: `REMOVE envelope SET status = :ended, endedAt = :now, endedReason = :consumed, purgeAt = :now + 30d, viewsRemaining = :zero, retrievals = list_append(...)` (plus the sweep index keys, section 8), with condition `attribute_exists(pk) AND status = :ready AND expiresAt > :now AND (attribute_not_exists(availableFrom) OR availableFrom <= :now) AND consumeTokenHash = :h AND viewsRemaining = :one`, `ReturnValues ALL_OLD`. Return the envelope from the old item. S3 deletion of `<id>/*` follows after the presigned GET window: the tombstone puts the item in the `files` partition of the sweep index at `endedAt + 5 min`, and the sweeper deletes the objects then.
3. Else: `UpdateItem` setting `viewsRemaining = viewsRemaining - 1` (when not null) and appending `{ at, country }` to `retrievals`, condition `attribute_exists(pk) AND status = :ready AND expiresAt > :now AND (attribute_not_exists(availableFrom) OR availableFrom <= :now) AND consumeTokenHash = :h AND (attribute_not_exists(viewsRemaining) OR viewsRemaining > :one)`, `ReturnValues ALL_NEW`.
4. On `ConditionalCheckFailedException`, re-read once and take the other branch if applicable; otherwise 404. Two concurrent consumes of a one-time secret: exactly one succeeds.
5. Expiry and availability are enforced in the condition, not by TTL. TTL is cleanup only (DynamoDB deletes within about 48 hours).

9.2 Release later: before `availableFrom` the reveal page shows "This secret becomes available on <date>" with a countdown; no retrieval happens.

9.3 Delete via manage link: conditional update to a tombstone (`endedReason = deleted`, envelope removed, `purgeAt = now + 30 d`) plus S3 object deletion. A concurrent consume either wins or gets 404. Both acceptable.

9.4 Defaults: burn after reading (`maxViews 1`), `expiresAt = now + 7 days`, no release delay, no passphrase.

9.5 Presigned download URLs are valid 2 minutes and single-purpose; the object is deleted after the final consume regardless of whether the download completed. The UI starts all downloads immediately after decryption of the text payload and warns the recipient to save files before leaving.

9.6 Sweeper (every 5 minutes): via the `sweep-due` GSI, convert live items with `expiresAt <= now` to tombstones (`endedReason = expired`, envelope removed); delete `pending` items older than 1 hour (item first, then objects); delete the objects of ended secrets 5 minutes after `endedAt`; delete bucket prefixes without an item, or whose item ended more than 5 minutes ago, once their objects are older than 5 minutes. Lifecycle rule at 31 days is the backstop. Consume and status also convert an expired live item to a tombstone on the fly, so the manage page is correct even before the sweeper runs.

9.7 Tombstones: a tombstone is the same item with the envelope removed and `status = ended`. It is never retrievable (consume → 404). It is readable only via the manage token. It carries no ciphertext, no file objects and no IP addresses; only timestamps, policy, country codes and the end reason. TTL removes it 30 days after `endedAt`. Rationale: the sender's main question after the fact is "was it opened, when, and from where", and they may be away for weeks.

## 10. Frontend and UX

Stack: TypeScript, Vite, Preact (or vanilla; keep the bundle small and dependency-light), Tailwind with Brix design tokens, self-hosted fonts. No analytics, no third-party requests, no cookies, no service worker.

Branding source: the Brix Design System (Brix's internal design system) for tokens and assets. How it is used:
- Tokens and logos are copied into `design/brand/`, with their origin recorded in `design/brand/SOURCE.md`. Tokens from `colors_and_type.css` become the Tailwind theme (colors, radii, spacing, shadows, motion). Do not invent colors.
- Fonts and icons are self-hosted (fonts as WOFF2 in `web/src/assets/fonts`, Lucide icons bundled as inline SVG), which keeps the CSP at `'self'` only.
- Type matches the Brix consumer app: Archivo for text, Space Grotesk (500) for page titles and the wordmark, DM Mono for timestamps, countdowns, generated passphrases, share and manage links, country codes and the retrieval log. All three are under the SIL Open Font License. Sentence case everywhere, no ALL CAPS tracked headings, no emoji.
- Visual rules: dark-first on `#0B0B0B`, Brix Orange `#DF7032` as the only accent (primary button, focus ring, active states), hairline borders `rgba(255,255,255,0.10)` instead of shadows, buttons as 99 px pills, inputs 8 px radius, panels 16 px radius, focus ring `0 0 0 3px rgba(223,112,50,0.40)`, 200 ms hover transitions, press at 97 % scale, no bounce. Logo is white only, never orange. Candlestick-flow texture is optional as a faint page background; not required.
- Mode: dark only in v1. The design system defines dark semantic tokens only, and the brand is dark-first. Light mode is dropped from the v1 requirements (section 2 updated).
- Copy voice: declarative, short sentences, no exclamation marks. Example button labels: "Create secure link", "Reveal secret", "Delete now", "Copy link".

Routes (SPA, single `index.html`):
- `/` create. Layout modeled on Hemmelig: left column with Title (optional) and the secret textarea plus an "Attach files" dropzone (shows total size, 25 MB cap); right column with options: Expires after (1 h, 1 d, 7 d, 14 d, 30 d, custom), Max views (Burn after reading selected by default; 1 to 100; "Unlimited until expiry"), Release later (date-time picker, off by default), Passphrase (off by default, explained as: "Extra layer for highly sensitive secrets. A second secret you pass on over a second channel, so the link alone is not enough."; when on, a generated five-word phrase with regenerate and copy, editable with a strength meter). Primary button "Create secure link". A short "preparing" state while proof-of-work runs and files encrypt.
- Result view: share link with copy and QR code, manage link with copy, passphrase if set with copy, policy summary, title echoed back. Text: "Send the link and the passphrase through different channels. Anyone with the link can open the secret. Keep the manage link to yourself." Buttons: "Create another", "Open manage page".
- `/s/{id}#{K_link}` reveal: "You have been sent a secret. It can be opened N more time(s) / until <date>. Opening it counts as a retrieval." If release later: countdown. Button "Reveal secret". If the envelope has a passphrase, the field appears after retrieval and before decryption; retries do not consume again. Decrypted view: title, text in a readonly textarea with copy, file list with download buttons (v1.1: no auto-start, a click per file), "Clear from screen" (v1.1: asks first when the secret has a view limit). v1.1: an unavailable secret shows as such on load, from the availability check. Missing fragment: "This link is incomplete. Ask the sender to resend it in full."
- `/m/{id}#{T_manage}` manage: status, policy, retrieval log (time and country), "Delete now" with confirmation. After deletion: "Deleted. Nothing remains on our servers."
- `/about` (v1.1: split into `/how-it-works` and `/privacy`, `/about` an alias of the first): what the service protects against and what it does not (section 4), how link previews are handled, retention cap, contact.

Accessibility: keyboard navigable, visible focus, labels on every control, reduced-motion respected.

## 11. Security hardening checklist

Headers (CloudFront response headers policy, mirrored by Lambda on `/api`):
- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://<files-bucket>.s3.eu-central-1.amazonaws.com; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` (the S3 host is the only external connect target, for presigned PUT and GET).
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `X-Robots-Tag: noindex, nofollow` plus `robots.txt` disallow all
- `Cache-Control: no-store` on `/api/*` and `index.html`; hashed assets immutable.
- `Permissions-Policy` denying everything not needed.
- `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.

Delivery integrity (reduces, does not eliminate, the section 4 residual risk):
- Open-source repo in the Brix GitHub org: no secrets in the history; environment specifics (account, domain, zone, alert routing) kept out of the repository in the stage config.
- Reproducible build (pinned lockfile, pinned Node via `.nvmrc`, deterministic Vite output), release tags, SHA-256 of built assets published on the release page (implemented: a GitHub release per `v*` tag).
- Frontend deploy via a dedicated CI role that can only write to the static bucket and invalidate CloudFront; API deploy via a separate role. Bucket policy denies `s3:PutObject` from any principal other than that role. No human write access in daily use. (Implemented differently: deploys are manual and there are no CI deploy roles; a human admin assumes the dedicated web deploy role, the only principal the static bucket accepts writes from. See DECISIONS.md 2026-10-09.)
- SRI attributes on all script and style tags.
- Build version and commit in HTML metadata and the footer; `/verify` and the canonical README explain independent hash checks against the GitHub release manifest, signed with GitHub artifact attestations. Reproducible builds remain the root of trust; this adds detection, not protection against all targeted delivery.
- External change monitor outside the AWS account (for example a GitHub Actions schedule): fetches `index.html` and the asset manifest hourly, alerts to Slack when hashes differ from the latest release.
- Dependencies: minimal runtime deps, pnpm with the existing 7-day cooldown, `pnpm.onlyBuiltDependencies` allowlist, lockfile review on every bump, Renovate.

Logging and data handling:
- No request bodies, Authorization, x-manage-token or x-consume-token headers, envelopes or presigned URLs in any log, metric, trace, WAF sample or error reporter. WAF sampled requests off for `/api/*`.
- CloudFront standard logs ON, retained 30 days in a restricted bucket, as security logging (section 12). Query strings are never used by the app; fragments never reach the server.
- S3 server access logs off (presigned URLs would otherwise be logged); use CloudTrail data events only if an incident requires it.
- IAM: `api` role limited to the one table, the files bucket prefix operations it needs, SSM read; `sweeper` role limited to GSI query, delete and S3 list/delete. No human role with `dynamodb:Scan` or `s3:GetObject` on the files bucket in daily use.

## 12. Abuse controls, IP addresses and GDPR

Abuse controls (anonymous creation stays open):
- WAF rate-based rules: `/api/secrets` POST 20 per 5 minutes per IP; `/api/secrets/*/consume` 60 per 5 minutes per IP; `/api/challenge` 60 per 5 minutes per IP; global rule 2000 per 5 minutes per IP.
- Size: 64 KB text, 25 MB files per secret, 128 KB JSON body cap at WAF and Lambda, presigned PUT pinned to the declared size.
- Retention cap 30 days, default 7.
- Proof-of-work on create (section 7), difficulty from SSM. Create-rate alarm (for example > 500 per hour) raises difficulty by 2 bits per step up to 24; it steps back down after an hour of calm.
- Global budgets: reserved concurrency 20 on `api`, alarms on creates per hour, table item count and bucket size, and a circuit breaker: sustained alarm flips `createEnabled` to false; a human resets it. Budget alerts alone do not cap spend.
- Internal higher limits: not in v1. If needed, individual identities (SSO), never a shared token in the SPA.

IP addresses:
- IP addresses are personal data under GDPR (CJEU Breyer). Processing them for abuse prevention and security is a recognised legitimate interest (Art. 6(1)(f), Recital 49), provided purpose, retention and access are limited and the processing is listed in the records of processing and the privacy notice. ISO 27001 control A.8.15 expects security logging.
- The application database stores no IP addresses. Items live up to 30 days and would otherwise mix the secret with who touched it.
- Forensics come from CloudFront access logs (client IP, path, time, no fragments, no bodies), retained 30 days, access restricted to the security role, documented as security logging. This covers creator and accessor IPs for incident response without building anything.
- Creators see retrieval timestamps and country (from the CloudFront geo header), never accessor IPs. Showing one party's IP to another would be a disclosure of personal data.
- Privacy notice on `/privacy`: what is stored (ciphertext, policy, retrieval time and country), for how long, access logs retention, no cookies, no analytics.

## 13. Delivery, environments, operations

- Repo `inverternetwork/brix-share`, pnpm workspace: `web/`, `api/`, `sweeper/`, `infra/` (CDK), `shared/` (envelope types, validation, test vectors shared by client and Lambdas).
- Stages: only `prod` (eu-central-1, `share.brix.money`). The stack stays parameterized by stage.
- CI: lint, typecheck, unit tests, Playwright, CDK synth, reproducible build check. No deploys from CI. Releases are `v*` tags on `main` with a published asset manifest; a human deploys a release with `scripts/deploy-infra.sh` and `scripts/deploy-web.ts` (see `docs/RUNBOOK.md`).
- Runbook: flipping the circuit breaker, adjusting proof-of-work difficulty, full purge in an incident (`DeleteTable` + empty bucket + redeploy is the fastest complete redaction), alarm meanings, how to read CloudFront logs for an incident and who may.
- Ownership: one named maintainer, quarterly dependency review, re-run the review on protocol version changes.

## 14. Testing requirements (acceptance criteria)

Unit (`shared`, `api`):
- Envelope validation rejects wrong lengths, versions, non-base64url, oversize, bad dates, out-of-range views, `availableFrom` outside bounds, file count or size over cap, `fileIds` mismatch.
- Proof-of-work: valid, expired, wrong difficulty, replayed challenge.
- Consume branches: one-time, N views, unlimited; expiry boundary at `now`; expired item 404 even if TTL has not deleted it; `availableFrom` in future → 425; pending → 404.
- Delete with right token, wrong token, missing item; S3 objects removed; tombstone written with reason `deleted`.
- Tombstones: consume returns 404, status returns full history, TTL set to `endedAt + 30 d`, expired live item becomes tombstone on status/consume and via sweeper.

Concurrency (DynamoDB Local or dev table):
- 50 parallel consumes of a one-time secret: exactly one 200, rest 404.
- 50 parallel consumes of a 10-view secret: exactly ten 200s.
- Delete racing consume: never two successes on a one-time secret; exactly one end reason recorded.

Crypto (Playwright in Chromium, Firefox, WebKit):
- Round trip text and files, with and without passphrase; wrong passphrase fails without a second consume; tampered ciphertext, IV, AAD, fileId or version fails.
- Known-answer test vectors pass.
- Fragment removed from the address bar after load; nothing in storage; no requests to hosts other than the site and the files bucket.

Security and behaviour:
- Headers present on every route (automated check).
- Plain GET of `/s/{id}` consumes nothing (curl, then check status via manage token).
- Release-later secret cannot be consumed before `availableFrom`.
- Lost-response simulation: consume committed, client never auto-retries.
- Log grep over a test run: no body, no Authorization header, no envelope, no presigned URL.
- Sweeper removes objects of expired and orphaned items.

## 15. Out of scope for v1, candidates for v2

- Pinned client for high-value exchanges: a single self-contained HTML file (same code, inlined) published with a SHA-256, downloaded once and opened locally. WebCrypto works from a local file; the API would need to accept that client (CORS allowlist for the `null` origin on the API routes or an `X-Client` header). Removes the served-JavaScript risk for users of the pinned file. Both ends must use it to be meaningful. Alternatively a CLI.
- Documented pre-encryption path for custody and signing keys: encrypt locally to the recipient's age or PGP public key (fingerprint verified via a channel we do not serve), then share through the service. Publish a Brix team public key for the externals-to-us direction.
- Secret request links: Brix issues an expiring, quota-limited upload capability to an external sender; lets the public create path be tightened later.
- Retrieval notification to the creator (opt-in contact only).
- Argon2id KDF as protocol `v2` if user-chosen passphrases become common.
- IP allowlist per secret (Hemmelig has it; low value for us).
- Open-sourcing the repo for clients who want to audit it. (Done, AGPL-3.0.)
- Track Isolated Web Apps and WEBCAT (Sigstore-based web app code signing) as potential replacements for the pinned client.

## 16. Decisions

Resolved on 2026-10-09:
1. Name and domain: Brix Share at `share.brix.money`.
2. Hosting: own CDK stack in Brix's production AWS account. Conditions: split deploy roles, bucket write policy, no shared resources.
3. Retention cap: 30 days.
4. Size caps: 64 KB text, 25 MB files per secret.
5. KDF: PBKDF2-600k with generated passphrase by default, user may override with strength meter and warning. Argon2id deferred to v2.
6. Proof-of-work on create: yes, adaptive difficulty, circuit breaker as last resort.
7. IP addresses: none in the app database; creators see time and country only. CloudFront log retention per decision 12.
8. Review: two independent adversarial review passes on the crypto module and consume path, then teammate review. External pentest later if clients start relying on it.
9. Repo: open source under AGPL-3.0; the Brix brand is excluded (see README).

10. Tombstone: metadata-only history kept 30 days after the secret ends, readable via the manage link.
11. Name: Brix Share, `share.brix.money`. Final.

12. IP logging: CloudFront access logs on, 30 days, restricted access, as security logging under legitimate interest (section 12).
14. One named maintainer (section 13).

## 17. Build order

1. Repo scaffold, shared envelope schema and validators, test vectors, Brix design tokens.
2. CDK: stack skeleton, table + GSI, `api` Lambda with function URL and OAC, static bucket, CloudFront, WAF, headers policy, SSM parameters, alarms, split deploy roles.
3. API (text): challenge + proof-of-work, create, consume state machine with release later, status, delete, health. Unit and concurrency tests.
4. Web (text): brand files from the Brix Design System in `design/brand/`, self-host fonts and icons, Tailwind theme from tokens; crypto module, create flow with all options, result view, reveal flow, manage flow, about page. Playwright tests.
5. CI/CD, reproducible build, published asset hashes, external change monitor, log scrubbing verification, runbook. First go-live.
6. Files: presigned upload and download, finalize, file envelopes in the client, sweeper, bucket lifecycle, tests.
7. Adversarial security reviews and teammate review, fix findings, prod go-live.

## 18. Sources

- Hemmelig repository (archived 2026-10-05, O'Saasy license on v7): https://github.com/HemmeligOrg/Hemmelig.app
- Hemmelig README (feature list): https://raw.githubusercontent.com/hemmeligorg/hemmelig.app/main/README.md
- PrivateBin encryption format: https://github.com/PrivateBin/PrivateBin/wiki/Encryption-format
- Yopass README: https://raw.githubusercontent.com/jhaals/yopass/master/README.md
- Cryptgeon README (multi-instance view-count race warning): https://github.com/cupcakearmy/cryptgeon
- Password Pusher security docs (server-side model): https://docs.pwpush.com/docs/security/
- Bitwarden Send lifespan: https://bitwarden.com/help/send-lifespan.md
- OWASP Password Storage Cheat Sheet (Argon2id preferred, PBKDF2-HMAC-SHA256 600k): https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- EFF wordlists for generated passphrases: https://www.eff.org/dice
- DynamoDB conditional writes: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateItem.html , https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_DeleteItem.html
- DynamoDB TTL timing: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html
- API Gateway HTTP vs REST (WAF support): https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html
- W3C Subresource Integrity: https://www.w3.org/TR/SRI/
- GDPR Recital 49 (network and information security as legitimate interest): https://gdpr-info.eu/recitals/no-49/
- Brix Design System (internal): README, colors_and_type.css, preview cards
