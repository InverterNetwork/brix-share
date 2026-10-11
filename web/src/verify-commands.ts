export const VERSION_COMMAND = `# Use the exact URL you are about to use, without its #fragment.
url='https://share.brix.money/'
# For a share link, replace <id> with its actual id:
# url='https://share.brix.money/s/<id>'
curl -fsS --compressed "$url" | grep brix-share-version`;
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
curl -fsS --compressed "$url" | (
  if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi
)
# Response headers must show Cache-Control: no-store:
curl -fsSI --compressed "$url" | grep -i '^cache-control:'`;
export const WINDOWS_COMMAND = `# Use the exact URL you are about to use, without its #fragment.
$url = 'https://share.brix.money/'
# For a share link: $url = 'https://share.brix.money/s/<id>'
Invoke-WebRequest $url -OutFile index.html
Get-FileHash index.html -Algorithm SHA256`;
export const ALL_FILES_COMMAND = `# Requires jq and bash. Runs in a subshell so your shell stays unchanged.
(
  set -o pipefail
  base=https://share.brix.money
  # Validate the manifest before the loop; failed downloads or hashes stop this check.
  jq -er '.files | to_entries[] | [.key, .value] | @tsv' manifest.json > /dev/null || exit 1
  while IFS=$'\\t' read -r path expected; do
    actual=$(curl -fsS --compressed "$base$path" | shasum -a 256) || exit 1
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

export const COMPARE_COMMAND = `jq -r '.files["/index.html"]' manifest.json`;
export const WINDOWS_VERSION_COMMAND = `# Use the exact URL without its #fragment; replace <id> for a share link.
$url = 'https://share.brix.money/'
# $url = 'https://share.brix.money/s/<id>'
(Invoke-WebRequest $url -ErrorAction Stop).Content | Select-String 'brix-share-version'`;
export const WINDOWS_MANIFEST_COMMAND = `# Use the served version, after checking the latest release on GitHub.
$version = 'vX.Y.Z'
Invoke-WebRequest "https://github.com/InverterNetwork/brix-share/releases/download/$version/manifest.json" -OutFile manifest.json -ErrorAction Stop`;
export const WINDOWS_HASH_COMMAND = `# Use the same exact $url set above, without the #fragment.
Invoke-WebRequest $url -OutFile index.html -ErrorAction Stop
Get-FileHash index.html -Algorithm SHA256
# Must show no-store:
(Invoke-WebRequest $url -Method Head -ErrorAction Stop).Headers['Cache-Control']`;
export const WINDOWS_COMPARE_COMMAND = `(Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).files.'/index.html'`;
export const WINDOWS_ATTEST_COMMAND = `gh attestation verify manifest.json -R InverterNetwork/brix-share --signer-workflow InverterNetwork/brix-share/.github/workflows/release.yml --source-ref "refs/tags/$version"`;
export const WINDOWS_COMMIT_COMMAND = `# In a clone; paste the full release commit from GitHub.
$commit = 'FULL_RELEASE_COMMIT_SHA'
git fetch origin main
git branch -r --contains $commit
# The output must include origin/main.`;
export const WINDOWS_HAR_COMMAND = `# Use the same exact $url, without the #fragment.
$har = Get-Content browser.har -Raw -Encoding UTF8 | ConvertFrom-Json
$entries = @($har.log.entries | Where-Object { $_.request.url -ceq $url })
if ($entries.Count -ne 1 -or $null -eq $entries[0].response.content.text) { throw 'Need exactly one document response with content' }
$content = $entries[0].response.content
if ($content.encoding -eq 'base64') {
  $bytes = [Convert]::FromBase64String($content.text)
} elseif (!$content.encoding -or $content.encoding -eq 'text') {
  $bytes = [Text.Encoding]::UTF8.GetBytes($content.text)
} else { throw 'Unsupported HAR encoding' }
[IO.File]::WriteAllBytes((Join-Path $PWD 'browser-index.html'), $bytes)
Get-FileHash browser-index.html -Algorithm SHA256`;
export const WINDOWS_ALL_FILES_COMMAND = `# A local scope keeps options and failures inside this check.
& {
  $ErrorActionPreference = 'Stop'
  $base = 'https://share.brix.money'
  $manifest = Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json
  $files = @($manifest.files.PSObject.Properties)
  if ($files.Count -eq 0) { throw 'Manifest has no files' }
  $temp = [IO.Path]::GetTempFileName()
  try {
    foreach ($file in $files) {
      if (!$file.Name.StartsWith('/') -or $file.Value -notmatch '^[0-9a-f]{64}$') { throw 'Invalid manifest entry' }
      Invoke-WebRequest "$base$($file.Name)" -OutFile $temp
      $actual = (Get-FileHash $temp -Algorithm SHA256).Hash
      if ($actual -ne $file.Value) { throw "MISMATCH $($file.Name)" }
      "OK $($file.Name)"
    }
  } finally { Remove-Item $temp }
}`;
