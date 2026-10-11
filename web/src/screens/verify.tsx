import type { ComponentChildren } from 'preact';
import { BUILD_INFO, REPOSITORY } from '../build-info.ts';
import { Lede, PageTitle, Panel } from '../ui/kit.tsx';
import {
  ALL_FILES_COMMAND,
  ATTEST_COMMAND,
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
            script, so matching index.html pins that code. Use GitHub and your own tools to check; a
            badge on this page would prove nothing.
          </P>
        </Panel>
        <Panel>
          <H>Check it yourself</H>
          <P>
            1. Read the deployed version. This is a label, not proof; confirm it independently on
            GitHub.
          </P>
          <Code>{VERSION_COMMAND}</Code>
          <P>
            2. Open{' '}
            <a href={releaseUrl} class="text-white underline">
              the GitHub release
            </a>{' '}
            and find /index.html in the hash table, or download its manifest.json and read that
            entry. Never take the expected hash from this site.
          </P>
          <Code>{MANIFEST_COMMAND}</Code>
          <P>
            3. Optionally verify the manifest with the GitHub CLI. Check the reported workflow, tag
            and commit against the release. Restricting the signer and source ref binds the check to
            the release workflow and chosen tag.
          </P>
          <Code>{ATTEST_COMMAND}</Code>
          <P>
            4. Hash the served document on macOS or Linux and compare the result with the manifest’s
            /index.html entry. Equality means this response matches that release.
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
            If you have a Network HAR export with response content, extract the original document
            entry without adding a newline, then compare its hash. Check that there is exactly one
            matching entry and that its content.text is present; an export without response bodies
            cannot verify the document. This extraction is tested against Playwright HAR recordings
            in Chromium, Firefox and WebKit; it does not validate native Chrome, Firefox or Safari
            export menus. Browser-specific UI instructions await that validation.
          </P>
          <Code>{HAR_COMMAND}</Code>
          <H>Optional: check every file</H>
          <P>This also covers the proof-of-work worker and static assets.</P>
          <Code>{ALL_FILES_COMMAND}</Code>
          <P>
            If any hash differs, or verification fails, do not use the site. Report it to{' '}
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
