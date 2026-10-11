# Deploying Brix Share

Deploys are manual, by an admin with an SSO session. Nothing deploys from CI. Full details and incident procedures: [`docs/RUNBOOK.md`](RUNBOOK.md).

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
