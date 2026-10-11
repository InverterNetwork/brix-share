#!/usr/bin/env bash
# Deploys the CDK stacks of a stage, Lambda code included. Run by a human with an admin SSO session:
#   AWS_PROFILE=<prod-admin-profile> scripts/deploy-infra.sh prod
# Refuses a dirty tree or a commit that is not on origin/main, fetches the stage config from the STAGES_JSON
# repository variable, shows the diff, asks, deploys, and records the
# deployed commit in the repository variable DEPLOYED_INFRA_<STAGE>.
set -euo pipefail
cd "$(dirname "$0")/.."
stage="${1:?usage: deploy-infra.sh <stage> [zone]}"
part="${2:-all}"
: "${AWS_PROFILE:?set AWS_PROFILE to the admin profile of the stage}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean: commit or stash first. CDK bundles the Lambda code from this checkout."
  exit 1
fi
git fetch -q origin main
commit="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "HEAD $commit is not on origin/main. Deploy only reviewed, pushed code."
  exit 1
fi
pnpm install --frozen-lockfile >/dev/null
# Stage config is not in the repository; the STAGES_JSON repository variable is the source (git-ignored copy).
gh variable get STAGES_JSON > infra/stages.json

cd infra
if [[ "$part" == "zone" ]]; then
  stacks=("BrixShare-${stage}-zone")
else
  # Zone (only for a delegated zone the stack creates), edge (us-east-1: WAF, certificate), then main.
  stacks=()
  mode="$(node -e "console.log(require(process.argv[1])[process.argv[2]].hostedZone.mode)" "$PWD/stages.json" "$stage")"
  [[ "$mode" == "create" ]] && stacks+=("BrixShare-${stage}-zone")
  stacks+=("BrixShare-${stage}-edge" "BrixShare-${stage}")
fi

pnpm exec cdk diff "${stacks[@]}"
read -r -p "Deploy ${stacks[*]} at ${commit:0:12} with profile ${AWS_PROFILE}? [y/N] " answer
[[ "$answer" == "y" ]] || { echo "Aborted."; exit 1; }
# The diff above (including IAM changes) was confirmed with "y"; do not ask again (it needs a TTY).
pnpm exec cdk deploy "${stacks[@]}" --require-approval never --exclusively
gh variable set "DEPLOYED_INFRA_${stage^^}" --body "$commit"
# The monitor workflow gets only public facts; the full stage config never goes into a workflow (logs show env).
gh variable set MONITOR_STAGES --body "$(node -e '
  const all = require(process.argv[1]);
  const pick = ({ region, domainName, customDomain, siteUrl, filesBucketSuffix }) =>
    ({ region, domainName, customDomain, siteUrl, filesBucketSuffix });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, pick(v)]))));
' "$PWD/stages.json")"
echo "Deployed ${stacks[*]} at $commit."
