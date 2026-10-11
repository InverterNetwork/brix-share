#!/usr/bin/env bash
# Runs the Playwright suite in the official Playwright image (browsers and system libraries included),
# against DynamoDB Local. Docker here is rootless, so the container's root maps to the invoking user.
# Used locally; CI installs browsers on the runner instead. Extra args go to
# `playwright test`, e.g. `scripts/e2e-docker.sh --project=chromium`.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB="$(pwd)"
REPO="$(cd .. && pwd)"
PW_IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
DDB_IMAGE="amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab"
DDB_PORT="${DDB_PORT:-8011}"

pnpm build >/dev/null
ddb=$(docker run -d --rm -p "127.0.0.1:${DDB_PORT}:8000" "$DDB_IMAGE" -jar DynamoDBLocal.jar -inMemory)
trap 'docker rm -f "$ddb" >/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${DDB_PORT}" && break; sleep 0.5; done

docker run --rm --network host --ipc=host \
  -e HOME=/tmp -e CI=1 \
  -e DYNAMODB_ENDPOINT="http://127.0.0.1:${DDB_PORT}" \
  -v "$REPO:$REPO" -w "$WEB" \
  "$PW_IMAGE" node node_modules/@playwright/test/cli.js test "$@"
