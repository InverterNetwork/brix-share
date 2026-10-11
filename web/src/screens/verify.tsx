import type { ComponentChildren } from 'preact';
import { BUILD_INFO, REPOSITORY } from '../build-info.ts';
import { Lede, PageTitle, Panel } from '../ui/kit.tsx';
import {
  ALL_FILES_COMMAND,
  ATTEST_COMMAND,
  COMMIT_COMMAND,
  HAR_COMMAND,
  HASH_COMMAND,
  MANIFEST_COMMAND,
  VERSION_COMMAND,
  WINDOWS_COMMAND,
} from '../verify-commands.ts';

const P = ({ children }: { children: ComponentChildren }) => (
  <p class="mb-3 text-[15px] leading-relaxed text-fg-3">{children}</p>
);
const H = ({ children }: { children: ComponentChildren }) => (
  <h2 class="mb-3 text-lg font-semibold text-white">{children}</h2>
);
const Code = ({ children }: { children: string }) => (
  <pre class="mb-4 max-w-full overflow-x-auto rounded border border-line-soft p-3 font-mono text-xs text-fg-3">
    <code>{children}</code>
  </pre>
);

export function VerifyScreen() {
  const releaseUrl =
    BUILD_INFO.version === 'dev'
      ? `${REPOSITORY}/releases`
      : `${REPOSITORY}/releases/tag/${BUILD_INFO.version}`;
  return (
    <div class="min-w-0 max-w-[760px]">
      <PageTitle>Verify this site.</PageTitle>
      <Lede>
        Encryption happens in your browser. The code your browser loads decides whether your secret
        stays private.
      </Lede>
      <div class="flex min-w-0 flex-col gap-4">
        <Panel>
          <H>How we make it checkable</H>
          <P>
            The source is public. Every release is built twice and publishes SHA-256 hashes of every
            served file on GitHub, with a signed manifest attestation. Anyone can rebuild the tag
            and compare it with the manifest: reproducibility is the underlying root of trust.
          </P>
          <P>
            The release’s index.html pins the entry script and stylesheet with integrity hashes the
            browser enforces. The application bundles all code that handles secrets into that
            script. Every page path must return byte-identical index.html: check the exact URL you
            are about to use. Use GitHub and your own tools; a badge on this page would prove
            nothing.
          </P>
        </Panel>
        <Panel>
          <H>Check it yourself</H>
          <P>
            1. Read the version from the exact URL you are about to use: / for creating a secret,
            /s/&lt;id&gt; for revealing one, or /m/&lt;id&gt; for managing it. Remove the #fragment
            first; it contains the key or manage token and is never sent to the server. The version
            is a label, not proof.
          </P>
          <Code>{VERSION_COMMAND}</Code>
          <P>
            2. Confirm that the served version is{' '}
            <a href={`${REPOSITORY}/releases/latest`} class="text-white underline">
              the latest release on GitHub
            </a>
            . Right after a new release, the site can lag for a short while until it is deployed. An
            older legitimate release still passes its hash checks; an older version that stays live
            is a warning sign. Open{' '}
            <a href={releaseUrl} class="text-white underline">
              the release
            </a>{' '}
            and find /index.html in its hash table, or download manifest.json and read that entry.
            Never take the expected hash from this site.
          </P>
          <Code>{MANIFEST_COMMAND}</Code>
          <P>
            3. Confirm that the release’s full commit SHA is on main. Open its GitHub commit page
            and check the listed branches, or use the commands below in a clone. A tag name or an
            attestation alone does not establish that the code went through review.
          </P>
          <Code>{COMMIT_COMMAND}</Code>
          <P>
            Optionally verify the manifest with the GitHub CLI. Check its reported commit against
            the release commit you just checked. The signer and source-ref restrictions check the
            workflow and tag name; they do not prove that the commit was reviewed or belongs to
            main.
          </P>
          <Code>{ATTEST_COMMAND}</Code>
          <P>
            4. Hash the response from that same exact URL on macOS or Linux and compare it with the
            manifest’s /index.html entry. Checking /index.html alone cannot detect a different
            document served on a share link. Every path must return the same bytes. --compressed
            hashes the decompressed body, matching the manifest. Use your browser’s user agent;
            response headers must show Cache-Control: no-store.
          </P>
          <Code>{HASH_COMMAND}</Code>
          <P>On Windows, download the response with PowerShell and hash the file:</P>
          <Code>{WINDOWS_COMMAND}</Code>
          <H>The copy your browser received</H>
          <P>
            A server could send curl the release and your browser a different document. Checking
            your browser’s original document response is stronger. “Save page as”, copying the DOM
            or copying view-source text can change bytes; do not hash those as if they were the
            response.
          </P>
          <P>
            Open DevTools’ Network panel, load the exact URL without its #fragment, and export a HAR
            with response content as browser.har. Loading /s/&lt;id&gt; does not consume a
            retrieval; only clicking Reveal does. Select the document response, not an API response.
            Extract it without adding a newline and compare with the manifest’s /index.html hash.
            The commands require exactly one matching response with content. Browser-menu exports
            have not been checked in every browser.
          </P>
          <Code>{HAR_COMMAND}</Code>
          <P>
            Brix Share registers no service workers. Check your browser’s developer tools for
            service workers registered for share.brix.money; there must be none. If one is present,
            unregister it, reload and repeat the checks.
          </P>
          <H>Optional: check every file</H>
          <P>This also covers the proof-of-work worker and static assets.</P>
          <Code>{ALL_FILES_COMMAND}</Code>
          <P>
            If any hash differs, an older release stays live or verification fails, do not use the
            site. Report it to{' '}
            <a href="mailto:security@brix.money" class="text-white underline">
              security@brix.money
            </a>
            .
          </P>
        </Panel>
        <Panel>
          <H>Where trust starts, and what remains</H>
          <P>
            This page comes from the same site and could be tampered with too. If in doubt, use the
            canonical{' '}
            <a href={`${REPOSITORY}#verify-this-site`} class="text-white underline">
              README instructions on GitHub
            </a>
            . Trust still depends on GitHub, the reviewed source, your tools and your browser. An
            attestation establishes provenance, not that the code is safe, and checking one response
            does not verify future loads or the server’s access rules.
          </P>
          <P>
            The proof-of-work worker is outside the integrity chain because Workers cannot carry
            SRI. It receives no secret content or keys. For the highest-value keys, encrypt to the
            recipient’s verified public key first and use Brix Share as transport.
          </P>
        </Panel>
      </div>
    </div>
  );
}
