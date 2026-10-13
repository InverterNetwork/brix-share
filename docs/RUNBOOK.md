# Brix Share runbook

Operating the service: deploys, checks, the abuse controls, alarms, incidents. Architecture and claims: `docs/PLAN.md`. Judgment calls: `docs/DECISIONS.md`.

One stage: `prod`, eu-central-1; certificate and WAF in us-east-1. The stack stays parameterized by stage.

## Stage config

Account, domain, hosted zone, admin role pattern, files bucket suffix and alert routing are not in the repository. The source is the `STAGES_JSON` repository variable (format: `infra/stages.example.json`):

- `scripts/deploy-infra.sh` and `scripts/deploy-web.ts` write it to `infra/stages.json` (git-ignored) on every run. Other scripts read that local copy; fetch it with `gh variable get STAGES_JSON > infra/stages.json`.
- The full config never goes into a GitHub workflow: Actions prints a step's environment in the run log, and those logs are public. The monitor gets `MONITOR_STAGES` instead (domain, region, files bucket suffix; all public anyway), which `deploy-infra.sh` derives from the full config after each deploy.
- To change it: edit the local copy, `gh variable set STAGES_JSON < infra/stages.json`, then deploy infra. Never print it in a workflow log.
- `filesBucketSuffix` is fixed once deployed: changing it replaces the files bucket (and drops files of live secrets).

The file maps stage names to settings:

| Field | Required | Meaning |
|---|---|---|
| `account` | yes | AWS account id (12 digits) the stage deploys to |
| `region` | yes | Region of the main stack (`eu-central-1`); certificate and WAF always go to us-east-1 |
| `domainName` | yes | Public domain of the site, for example `share.example.com` |
| `hostedZone` | yes | `{ "mode": "create", "zoneName": "<domain>" }` lets the stack create and own the zone (delegate it once from the parent domain); `{ "mode": "existing", "zoneName", "zoneId" }` uses a zone that already exists |
| `adminRolePattern` | yes | Role path and name pattern (after `role/`) of the admin SSO role: the only principal that may assume the web deploy role and read access logs |
| `customDomain` | no | `true` once the zone is delegated: adds certificate, alias and DNS records. Without it the site runs on the CloudFront default domain |
| `siteUrl` | no | The `https://<id>.cloudfront.net` URL while `customDomain` is off (the monitor reads it) |
| `filesBucketSuffix` | yes | 8 to 16 lower-case letters and digits, random, for example `head -c 6 /dev/urandom \| od -An -tx1 \| tr -d ' \n'` |
| `alarmTopicArns` | no | Existing SNS topics (same account and region) that every alarm also notifies |
| `alarmEmail` | no | E-mail subscribed to the stage's alarm topic |
| `budgetUsd` | no | Monthly AWS Budget on the `app=brix-share` cost allocation tag |

Working locally without access to the variable: use the example, `BRIX_SHARE_STAGES=infra/stages.example.json pnpm synth`. Tests and CI always use the example.

## Who can do what

- Deploys are manual and need an admin SSO session: `aws sso login --profile <prod-admin-profile>`, then `AWS_PROFILE=<prod-admin-profile>`. CI has no AWS credentials.
- Only the account's `AWSReservedSSO_AdministratorAccess_*` role can assume `BrixShare-<stage>-web-deploy`, the one principal the static bucket accepts writes from, and only it can read the CloudFront access logs.
- Read-only checks (logs, metrics, alarms, SSM values) work with the `<prod-readonly-profile>` profile.

## Stacks

| Stack | Region | Contents |
|---|---|---|
| `BrixShare-prod-zone` | us-east-1 | Hosted zone `share.brix.money` (prod only) |
| `BrixShare-<stage>-edge` | us-east-1 | WAF web ACL; ACM certificate once `customDomain` is on |
| `BrixShare-<stage>` | eu-central-1 | Table, buckets, Lambdas, CloudFront, alarms, SSM parameters, web deploy role; alias and DNS records once `customDomain` is on |

The main stack reads the certificate and ACL from the edge stack with weak cross-region references: after any change to the edge stack, deploy the main stack again.

## Deploying

Prerequisites and the deployment walkthrough: [DEPLOYING.md](DEPLOYING.md).

### Infra and API

```
AWS_PROFILE=<prod-admin-profile> scripts/deploy-infra.sh prod
```

Refuses a dirty tree or a commit that is not on `origin/main` (the Lambda code is bundled from the checkout), shows `cdk diff`, asks, then deploys zone, edge and main (`--require-approval broadening`) and records the commit in the repository variable `DEPLOYED_INFRA_<STAGE>`. The prod account is CDK-bootstrapped in eu-central-1 and us-east-1.

Do not deploy a change to the `createEnabled`, `powDifficulty` or `governor` SSM resources while the breaker or a raised difficulty is engaged: CloudFormation rewrites the live value whenever the resource changes.

### Web

1. Tag a release on `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`. The `release` workflow builds twice, fails if the builds differ, and publishes `manifest.json` (SHA-256 of every served file) on the GitHub release.
2. Deploy that tag:

```
git checkout vX.Y.Z
AWS_PROFILE=<prod-admin-profile> node scripts/deploy-web.ts prod vX.Y.Z --dry-run   # prints the upload plan
AWS_PROFILE=<prod-admin-profile> node scripts/deploy-web.ts prod vX.Y.Z
```

The script builds locally from a clean tree at the tag and refuses to continue unless the local build equals the release manifest. It then assumes the web deploy role, uploads hashed assets (immutable caching) before `index.html` (`no-store`) with an explicit content type for every file (`web/delivery.ts`; with `nosniff` a guessed type breaks the site), keeps the previous release's files for one more deploy (open tabs still load their worker), removes older ones (on the versioned bucket that adds delete markers; versions stay 30 days), invalidates every non-hashed file, and records the tag in the repository variable `DEPLOYED_<STAGE>` that the monitor reads.

If it refuses because the local build differs from the release manifest: do not override. Compare Node and pnpm versions with the release notes, check for a dirty `node_modules`, and if the cause is in code, fix it and cut a new tag.

### First deploy of a new stage (CloudFront default domain)

1. Stage config with `customDomain: false`, a fresh random `filesBucketSuffix`, saved to `STAGES_JSON` (above).
2. `AWS_PROFILE=<prod-admin-profile> scripts/deploy-infra.sh <stage>`. Creates the zone stack (not yet delegated, so not in use), the edge stack (WAF) and the main stack. Note the outputs `NameServers` (zone stack) and `SiteUrl` (main stack, `https://<id>.cloudfront.net`).
3. Put `SiteUrl` into the stage config as `siteUrl` (the monitor reads it), tag a release and deploy it with `deploy-web.ts` (above), verify (below) against `SiteUrl`.
4. Make sure alarms reach a person: `alarmTopicArns` (an existing team topic), `alarmEmail`, or a manual subscription to the alarm topic; deploy infra again after changing the stage config.
5. Optional budget: set `budgetUsd`, and activate the `app` cost allocation tag in the payer (management) account's Billing console.

### Switching on the custom domain

1. At the parent domain's DNS provider, create NS records for the service domain with the four name servers from the zone stack's `NameServers` output.
2. Wait until `dig NS <domain> +short` returns them (and `dig @8.8.8.8` too).
3. Set `customDomain: true` in the stage config, save it, then deploy infra. The edge stack gets the ACM certificate (validated through the delegated zone), the main stack the alias, TLS 1.2 policy and A/AAAA records; viewer-request functions on both the static and API behaviors redirect the default CloudFront domain (and any other noncanonical host) with 301 to the HTTPS custom domain before SPA rewriting on the static behavior; the API function never rewrites URIs. Original share and manage paths are preserved, and browsers inherit the fragment. Files bucket CORS allows only the custom origin. The initial smoke-test mode keeps the CloudFront origin usable.
4. Verify against the custom domain. The monitor switches to it on its own (`customDomain` wins over `siteUrl`).

Deploying the domain before the delegation works hangs on certificate validation; keep the order.

## Verifying a stage

```
node scripts/verify-live.ts prod <site url> vX.Y.Z
AWS_PROFILE=<prod-readonly-profile> node scripts/scrub-logs.ts prod /tmp/brix-verify-<run>.json
```

It creates 6 secrets; the WAF allows 20 creates per 5 minutes per IP, so do not run it more than three times in a row from one address.

`verify-live` needs `cloudformation:DescribeStacks` in the stage region when the custom domain is enabled, to read the public `DistributionDomainName` output and check its 301 redirects on root, share, manage and `/api/health` paths. It never follows those redirects when checking them.

`verify-live` exercises every flow against the live stage (create with real proof-of-work, reveal, N views, release later, passphrase, manage, delete, tombstone, link-preview GET, headers, OAC body-hash enforcement, served files equal the deployed manifest). `scrub-logs` searches the Lambda log groups for every id, token, ciphertext fragment and presigned URL marker from that run; any hit is a failure.

## Abuse controls

### Circuit breaker

Stop all new secrets (existing ones keep working):

```
aws ssm put-parameter --name /brix-share/<stage>/createEnabled --value false --overwrite
```

Re-enable with `--value true`. The governor switches it off by itself after 60 minutes of create-rate alarm at difficulty 24; it never switches it back on. Values are cached up to 60 s per Lambda container.

### Proof-of-work difficulty

```
aws ssm get-parameter --name /brix-share/<stage>/powDifficulty
aws ssm put-parameter --name /brix-share/<stage>/powDifficulty --value 20 --overwrite
```

Range 8 to 24 (clamped by the API). Default 18. The governor raises it by 2 every 15 minutes while the create-rate alarm fires and lowers it by 2 per calm hour, never below 18. Its bookkeeping is `/brix-share/<stage>/governor`.

### HMAC key for challenges

`/brix-share/<stage>/powHmacKey` (SecureString) is created by the API itself on first use and is not part of the stack. To rotate: delete the parameter; the next cold start creates a new one. Outstanding challenges (10 minutes) become invalid; nothing else is affected. It survives stack deletion; delete it by hand when removing a stage.

### WAF

Rate limits per IP and 5 minutes: create 20, consume 60, challenge 60, everything 2000. Bodies over 128 KB are blocked by `Content-Length`. Sampled requests are off. Metrics per rule in CloudWatch (us-east-1, namespace `AWS/WAFV2`).

## Alarms

All go to the SNS topic of the stage and to every topic in `alarmTopicArns` (prod: the team's alerts topic, which a forwarder posts to the team's Slack channel), on ALARM and again on OK (that forwarder posts ALARM only). Alarm names are `BrixShare-<stage>-<Name>`.

| Alarm | Meaning | First response |
|---|---|---|
| `CreateRateHigh` | More than ~500 creates per hour | Watch the governor; check WAF metrics for a single source; consider the breaker |
| `CreatesDailyHigh` | More than 2000 creates in 24 hours | Slow, steady abuse under the hourly trigger; same as above |
| `ConsumeRateHigh` | More than 3000 consumes per hour | Check for scraping of guessed ids (should all be 404) in the access logs |
| `Api5xx` | 5 or more 5xx responses in 5 minutes | `aws logs tail` the api log group for `"event":"error"`; error names only are logged |
| `ApiErrors`, `SweeperErrors`, `GovernorErrors` | Lambda invocation errors | Same; check recent deploys |
| `ApiThrottles`, `SweeperThrottles` | Reserved concurrency exhausted (api: 20) | Abuse or a traffic spike; WAF and breaker |
| `TableItemCountHigh` | More than 100k items | Abuse; breaker; check sweeper runs |
| `FilesBucketSizeHigh` | Files bucket above 10 GB | Abuse via files; breaker; check sweeper and lifecycle |
| Budget (optional) | Forecast above the monthly budget | Find the cost driver in Cost Explorer |

## Incidents

### Removing a reported secret (takedown)

For reports under the Acceptable use policy (`/acceptable-use`) or a request from an authority. The id is the part of the link after `/s/` (or `/m/`); the key after `#` is not needed and should not be requested. Nobody can see the content: the files bucket denies reads to everyone but the API role, and everything is encrypted with a key we never receive.

1. Record what we hold, if the report may need an answer (read-only profile): `aws dynamodb get-item --table-name <TableName> --key '{"pk":{"S":"S#<id>"}}' --projection-expression '#s, createdAt, expiresAt, endedAt, endedReason, retrievals' --expression-attribute-names '{"#s":"status"}'`. Retrieval IPs are in the CloudFront access logs (see below) as `POST /api/secrets/<id>/consume`, for 30 days. Only hand anything over through the proper channel.
2. Delete the item (admin profile): `aws dynamodb delete-item --table-name <TableName> --key '{"pk":{"S":"S#<id>"}}'`.
3. Delete its files at once: `aws s3 rm s3://<FilesBucketName>/<id>/ --recursive`. Without this step the sweeper removes them as orphans within about 10 minutes.

Afterwards the share link shows "This secret is not available" and the manage link "Nothing found". Keep a note of the date, the id and the reason; never note keys.

### Full purge (fastest complete redaction)

Removes every secret, tombstone and file of a stage:

1. Disable creation: `aws ssm put-parameter --name /brix-share/<stage>/createEnabled --value false --overwrite`. Wait at least 90 seconds for the 60-second parameter cache and in-flight API calls to drain.
2. Delete every table item, including tombstones and proof-of-work records, keeping the managed table, its TTL and indexes intact. The AWS CLI paginates the scan automatically. Run in Bash with `jq` installed, substituting the stack's table name:

```sh
set -euo pipefail
aws dynamodb scan --table-name <table> --projection-expression pk --consistent-read --output json |
  jq -c '.Items[]' |
  while IFS= read -r key; do
    aws dynamodb delete-item --table-name <table> --key "$key"
  done
aws dynamodb scan --table-name <table> --select COUNT --consistent-read --query Count --output text
```

Every reported count must be zero; repeat the deletion if anything remains. A failed command aborts the purge; keep the breaker off until it is resolved.

3. Empty the files bucket: `aws s3 rm s3://<files-bucket> --recursive`; `aws s3 ls s3://<files-bucket> --recursive` must show no objects.
4. Deploy infra/API and the web app from the release tag, then re-enable creation with `aws ssm put-parameter --name /brix-share/<stage>/createEnabled --value true --overwrite`. Wait at least 60 seconds before verification. Keep the breaker off throughout both deployments.

Table and bucket names are stack outputs (`TableName`, `FilesBucketName`). This is destructive and irreversible; it needs an admin session and should be a deliberate human decision. Do not delete the table out of band: CloudFormation does not recreate an unchanged missing resource on a normal deploy.

For v1.5.0, run this purge before deployment: consume tokens and per-file keys are mandatory, and secrets created before the release stop working. There are no token-less or keyless compatibility paths.

### Suspected tampering with the frontend

The monitor fails when the served `index.html` or assets differ from the deployed release. Then: take the site down by putting a static maintenance page in place (deploy a release that only says so) or by disabling the CloudFront distribution; check CloudTrail for `PutObject` on the static bucket and changes to the bucket policy, distribution and web deploy role; redeploy the last good release; tell users who created or opened secrets in the window to rotate what they shared.

### Reading CloudFront access logs

Logs are in the `AccessLogs` bucket of the stage under `cloudfront/`, retained 30 days. Only the admin role can read them (bucket policy). They contain client IPs: read them only for a concrete security or abuse question, note the reason, and never share IPs with users. Columns: date, time, edge, bytes, client IP, method, host, path, status, referrer (always empty), user agent; query strings are unused, fragments never reach the server.

## Monitor

`.github/workflows/monitor.yml` runs hourly. For each stage whose domain resolves it fetches `/`, `/index.html` and SPA paths (`/s/<random>`, `/m/<random>`, `/about`), which must all be the release's `index.html`, plus every file of the release, and checks content, content types, caching and every security header. A failure means the live site differs from the deployed release (or is down, or `DEPLOYED_<STAGE>` is missing). It posts to Slack when the `SLACK_WEBHOOK_URL` secret is set; otherwise GitHub notifies on the failed run.

What it can and cannot see:
- AWS account compromise that changes files, the CloudFront function or headers: detected within an hour.
- Cloaking (serving GitHub's IP ranges something else): not detectable by the monitor. `verify-live` from a laptop is the spot check.
- GitHub compromise: the monitor, the manifests, the tags and `DEPLOYED_<STAGE>` all live there and can be blinded. Mitigations: a tag ruleset that forbids deleting or moving `v*` tags, and only admins may set variables.
- A deployer's machine: can deploy anything, but the CI manifest is independent, so the monitor flags it unless a matching tag also went through the release workflow (visible in git history).

## Removing a stage

`cdk destroy` fails on the table (deletion protection) on purpose. Disable it first if removal is intended. The static and log buckets are retained; empty and delete them by hand. Delete the self-provisioned `powHmacKey` parameter.

## Ownership

One named maintainer (PLAN decision 14). Quarterly: dependency review (lockfile diff, 7-day cooldown stays on), re-run the test suites, check alarms still have subscribers, check CloudFront log retention. Any change to the crypto protocol is a new protocol version with new vectors and a new review.
