export const VERSION_COMMAND = `# Use the exact URL you are about to use, without its #fragment.
url='https://share.brix.money/'
# For a share link, replace <id> with its actual id:
# url='https://share.brix.money/s/<id>'
# Copy your browser's user agent here (this is an example):
ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
curl -fsS --compressed -A "$ua" "$url" | grep brix-share-version`;
export const MANIFEST_COMMAND = `# Replace vX.Y.Z with the served version, after checking the latest release on GitHub.
version=vX.Y.Z
curl -fL "https://github.com/InverterNetwork/brix-share/releases/download/$version/manifest.json" -o manifest.json
# Optional, with jq:
jq -r '.files["/index.html"]' manifest.json`;
export const COMMIT_COMMAND = `# In a clone of InverterNetwork/brix-share; paste the full release commit from GitHub.
commit=FULL_RELEASE_COMMIT_SHA
git fetch origin main
git branch -r --contains "$commit"
# The output must include origin/main.`;
export const ATTEST_COMMAND = `gh attestation verify manifest.json -R InverterNetwork/brix-share
# Also constrain the signer and tag (recommended):
gh attestation verify manifest.json -R InverterNetwork/brix-share \\
  --signer-workflow InverterNetwork/brix-share/.github/workflows/release.yml \\
  --source-ref "refs/tags/$version"`;
export const HASH_COMMAND = `# Hash the same exact $url set above, without its #fragment.
curl -fsS --compressed -A "$ua" "$url" | shasum -a 256
# Linux:
curl -fsS --compressed -A "$ua" "$url" | sha256sum
# Response headers must show Cache-Control: no-store:
curl -fsSI --compressed -A "$ua" "$url" | grep -i '^cache-control:'`;
export const WINDOWS_COMMAND = `# Use the exact URL you are about to use, without its #fragment.
$url = 'https://share.brix.money/'
# For a share link: $url = 'https://share.brix.money/s/<id>'
# Copy your browser's user agent here (this is an example):
Invoke-WebRequest $url -UserAgent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' -OutFile index.html
Get-FileHash index.html -Algorithm SHA256`;
export const ALL_FILES_COMMAND = `# Requires jq and bash. Runs in a subshell so your shell stays unchanged.
(
  set -o pipefail
  base=https://share.brix.money
  ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  # Validate the manifest before the loop; failed downloads or hashes stop this check.
  jq -er '.files | to_entries[] | [.key, .value] | @tsv' manifest.json > /dev/null || exit 1
  while IFS=$'\\t' read -r path expected; do
    actual=$(curl -fsS --compressed -A "$ua" "$base$path" | shasum -a 256) || exit 1
    actual=\${actual%% *}
    [ "$actual" = "$expected" ] || { echo "MISMATCH $path"; exit 1; }
    echo "OK $path"
  done < <(jq -r '.files | to_entries[] | [.key, .value] | @tsv' manifest.json)
)`;
export const HAR_COMMAND = `# Requires jq; use the same exact $url, without its #fragment.
# browser.har must contain exactly one response for that URL, with content.
jq -e --arg url "$url" '[.log.entries[] | select(.request.url == $url)] | length == 1 and (.[0].response.content.text | type == "string")' browser.har
jq -r --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.encoding // "text"' browser.har
# If encoding is "text":
jq -j --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.text' browser.har | shasum -a 256
# If encoding is "base64" (macOS and Linux):
jq -j --arg url "$url" '.log.entries[] | select(.request.url == $url) | .response.content.text' browser.har | base64 -d | shasum -a 256`;
