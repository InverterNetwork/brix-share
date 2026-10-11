export const VERSION_COMMAND = 'curl -fsS https://share.brix.money/ | grep brix-share-version';
export const MANIFEST_COMMAND = `# Replace vX.Y.Z with the version you saw; inspect that release on GitHub too.
version=vX.Y.Z
curl -fL "https://github.com/InverterNetwork/brix-share/releases/download/$version/manifest.json" -o manifest.json
# Optional, with jq:
jq -r '.files["/index.html"]' manifest.json`;
export const ATTEST_COMMAND = `gh attestation verify manifest.json -R InverterNetwork/brix-share
# Also constrain the signer and tag (recommended):
gh attestation verify manifest.json -R InverterNetwork/brix-share \\
  --signer-workflow InverterNetwork/brix-share/.github/workflows/release.yml \\
  --source-ref "refs/tags/$version"`;
export const HASH_COMMAND = `curl -fsS https://share.brix.money/index.html | shasum -a 256
# Linux:
curl -fsS https://share.brix.money/index.html | sha256sum`;
export const WINDOWS_COMMAND = `Invoke-WebRequest https://share.brix.money/index.html -OutFile index.html
Get-FileHash index.html -Algorithm SHA256`;
export const ALL_FILES_COMMAND = `# Requires jq. Run in bash; replace the base for a local build.
set -o pipefail
base=https://share.brix.money
while IFS=$'\\t' read -r path expected; do
  actual=$(curl -fsS "$base$path" | shasum -a 256) || exit 1
  actual=\${actual%% *}
  [ "$actual" = "$expected" ] || { echo "MISMATCH $path"; exit 1; }
  echo "OK $path"
done < <(jq -r '.files | to_entries[] | [.key, .value] | @tsv' manifest.json)`;
export const HAR_COMMAND = `# Requires jq; use a HAR that includes response content.
# Set url to the exact document URL your browser loaded.
url=https://share.brix.money/
jq -e --arg url "$url" '[.log.entries[] | select(.request.url == $url)] | length == 1 and (.[0].response.content.text | type == "string")' browser.har
jq -r --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.encoding // "text"' browser.har
# If encoding is "text":
jq -j --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.text' browser.har | shasum -a 256
# If encoding is "base64" (Linux uses base64 --decode):
jq -j --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.text' browser.har | base64 -D | shasum -a 256`;
