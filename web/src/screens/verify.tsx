import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ArrowRight, Code2, FileCheck2, GitBranch, MonitorCheck } from 'lucide-preact';
import { REPOSITORY } from '../build-info.ts';
import { CopyButton, PageTitle, Panel, Segmented } from '../ui/kit.tsx';
import * as commands from '../verify-commands.ts';

type OS = 'unix' | 'windows';
const P = ({ children }: { children: ComponentChildren }) => (
  <p class="text-[15px] leading-relaxed text-fg-3">{children}</p>
);
const H = ({ children, id }: { children: ComponentChildren; id: string }) => (
  <h2 id={id} class="mb-4 text-lg font-semibold text-white">
    {children}
  </h2>
);
const Link = ({ href, children }: { href: string; children: ComponentChildren }) => (
  <a href={href} class="text-white underline">
    {children}
  </a>
);

function Code({ text, os }: { text: string; os: OS }) {
  return (
    <div class="mt-4 min-w-0 overflow-hidden rounded-sm border border-line-soft bg-field">
      <div class="flex items-center justify-between gap-3 border-b border-line-soft px-3 py-1.5">
        <span class="text-xs text-fg-3">{os === 'windows' ? 'PowerShell' : 'Terminal'}</span>
        <CopyButton key={text} text={text} variant="ghost" />
      </div>
      <pre
        tabIndex={0}
        aria-label="Command to copy"
        class="max-w-full overflow-x-auto p-3 font-mono text-xs leading-relaxed text-fg-2"
      >
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Step({
  number,
  title,
  id,
  children,
  text,
  os,
}: {
  number: number;
  title: string;
  id: string;
  children: ComponentChildren;
  text: string;
  os: OS;
}) {
  return (
    <li id={id} class="min-w-0">
      <Panel as="div">
        <h3 class="mb-2 flex items-center gap-3 text-base font-semibold text-white">
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-full border border-orange/30 bg-orange/10 text-sm text-orange"
            aria-hidden="true"
          >
            {number}
          </span>
          <span>
            <span class="sr-only">Step {number}: </span>
            {title}
          </span>
        </h3>
        <P>{children}</P>
        <Code text={text} os={os} />
      </Panel>
    </li>
  );
}

function Deeper({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: ComponentChildren;
}) {
  return (
    <details id={id} class="min-w-0 rounded-lg border border-line-soft bg-raised p-5 sm:p-6">
      <summary class="cursor-pointer text-[15px] font-semibold text-white">
        <span>{title}</span>
      </summary>
      <div class="mt-4 min-w-0 space-y-3">{children}</div>
    </details>
  );
}

export function VerifyScreen() {
  const [os, setOS] = useState<OS>('unix');
  const windows = os === 'windows';
  const pick = (unix: string, win: string) => (windows ? win : unix);
  const chain = [
    { icon: Code2, title: 'Public source', text: 'Code anyone can inspect' },
    { icon: GitBranch, title: 'Reproducible build', text: 'Built twice on GitHub' },
    { icon: FileCheck2, title: 'Release manifest', text: 'Hashes and signed provenance' },
    { icon: MonitorCheck, title: 'Your comparison', text: 'Check what your browser got' },
  ];
  return (
    <div class="min-w-0 max-w-[760px]">
      <PageTitle>Verify this site.</PageTitle>
      <p class="mt-3 max-w-[640px] text-[15px] leading-relaxed text-fg-3">
        Your browser encrypts your secrets, so changed website code could read them. These checks
        help you spot code that differs from our public release, including changes to our own
        hosting.
      </p>
      <p class="mt-3 mb-8 text-sm text-fg-3">
        Most people never need to do this; it exists so anyone can check us.
      </p>

      <section aria-labelledby="verify-chain" class="mb-8">
        <H id="verify-chain">How it fits together</H>
        <ol
          class="grid grid-cols-1 gap-3 sm:grid-cols-4"
          aria-label="From public source to your browser"
        >
          {chain.map(({ icon: Icon, title, text }, i) => (
            <li
              key={title}
              class="relative min-w-0 rounded-sm border border-line-soft bg-raised p-4"
            >
              <Icon aria-hidden="true" class="mb-3 size-5 text-orange" />
              <p class="mb-1 text-sm font-semibold text-white">{title}</p>
              <p class="text-xs leading-relaxed text-fg-3">{text}</p>
              {i < chain.length - 1 && (
                <ArrowRight
                  aria-hidden="true"
                  class="absolute -bottom-3 left-1/2 z-10 size-4 rotate-90 bg-bg text-muted sm:top-1/2 sm:-right-3 sm:bottom-auto sm:left-auto sm:rotate-0"
                />
              )}
            </li>
          ))}
        </ol>
        <p class="mt-4 text-sm leading-relaxed text-fg-3">
          Anyone can rebuild the tag and compare it with the manifest: reproducibility is the
          underlying root of trust.
        </p>
      </section>

      <section aria-labelledby="verify-quick" class="mb-8">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="verify-quick" class="text-lg font-semibold text-white">
            Quick check
          </h2>
          <Segmented<OS>
            label="Command operating system"
            value={os}
            onChange={setOS}
            options={[
              { value: 'unix', label: 'macOS / Linux' },
              { value: 'windows', label: 'Windows' },
            ]}
          />
        </div>
        <p class="mb-4 text-sm leading-relaxed text-fg-3">
          Use / to create a secret, /s/&lt;id&gt; to reveal one, or /m/&lt;id&gt; to manage it.
          Remove the #fragment first: it holds the key or manage token and is never sent to the
          server. A version label is not proof.
        </p>
        <ol class="space-y-3">
          <Step
            number={1}
            title="Read the version"
            id="verify-version"
            os={os}
            text={pick(commands.VERSION_COMMAND, commands.WINDOWS_VERSION_COMMAND)}
          >
            Read the build label from the exact URL you are about to use, without its #fragment.
          </Step>
          <Step
            number={2}
            title="Check the release"
            id="verify-release"
            os={os}
            text={pick(commands.MANIFEST_COMMAND, commands.WINDOWS_MANIFEST_COMMAND)}
          >
            Compare the served version with{' '}
            <Link href={`${REPOSITORY}/releases/latest`}>the latest release on GitHub</Link>, then
            download that served release’s manifest.
          </Step>
          <Step
            number={3}
            title="Hash that exact URL"
            id="verify-hash"
            os={os}
            text={pick(commands.HASH_COMMAND, commands.WINDOWS_HASH_COMMAND)}
          >
            Hash the decompressed body from the same fragment-free URL and check for Cache-Control:
            no-store.
          </Step>
          <Step
            number={4}
            title="Compare the hashes"
            id="verify-compare"
            os={os}
            text={pick(commands.COMPARE_COMMAND, commands.WINDOWS_COMPARE_COMMAND)}
          >
            Compare your result with the manifest’s /index.html entry from GitHub; every page path
            must return byte-identical index.html.
          </Step>
        </ol>
        <div class="mt-4 space-y-3">
          <P>
            A new release may briefly lag until deployed; an older version that stays live is a
            warning sign even if its hashes match.
          </P>
          <P>
            If anything differs or verification fails, do not use the site; report it to{' '}
            <Link href="mailto:security@brix.money">security@brix.money</Link>.
          </P>
        </div>
      </section>

      <section aria-labelledby="verify-deeper" class="mb-8">
        <H id="verify-deeper">Go deeper</H>
        <div class="space-y-3">
          <Deeper title="Verify the signed manifest" id="verify-attestation">
            <P>
              Optionally use the GitHub CLI to verify provenance, restricting the signer and tag
              name. Check its reported commit against the release commit; these restrictions do not
              prove that it was reviewed or is on main. Releases predating attestations have none.
            </P>
            <Code os={os} text={pick(commands.ATTEST_COMMAND, commands.WINDOWS_ATTEST_COMMAND)} />
          </Deeper>
          <Deeper title="Confirm the commit is on main" id="verify-commit">
            <P>
              Confirm the release’s full SHA is on main using the branches on its GitHub commit page
              or these commands in a clone. A tag or an attestation alone does not establish that
              the code went through review.
            </P>
            <Code os={os} text={pick(commands.COMMIT_COMMAND, commands.WINDOWS_COMMIT_COMMAND)} />
          </Deeper>
          <Deeper title="Check the copy your browser received" id="verify-browser">
            <P>
              A server can treat curl differently from a browser, so checking the copy your browser
              received is the stronger test. In DevTools’ Network panel, load the exact URL without
              its #fragment and export the original document response as browser.har with content;
              loading /s/&lt;id&gt; counts nothing, only clicking Reveal does.
            </P>
            <P>
              Extract exactly one matching response without adding a newline and compare it with the
              manifest’s /index.html hash. “Save page as”, DOM and view-source copies may change
              bytes. Browser-menu exports have not been checked in every browser.
            </P>
            <Code os={os} text={pick(commands.HAR_COMMAND, commands.WINDOWS_HAR_COMMAND)} />
          </Deeper>
          <Deeper title="Check for service workers" id="verify-workers">
            <P>
              Brix Share registers no service workers. Check your browser’s developer tools for
              service workers registered for share.brix.money; there must be none. If one is
              present, unregister it, reload and repeat the checks.
            </P>
          </Deeper>
          <Deeper title="Check every served file" id="verify-files">
            <P>
              The release’s index.html pins the entry script and stylesheet with integrity hashes
              the browser enforces; all code that handles secrets is bundled into that script.
              Checking every file also covers the proof-of-work worker and static assets. Workers
              cannot carry SRI, so this worker is outside the integrity chain; it receives no keys
              or secret content.
            </P>
            <Code
              os={os}
              text={pick(commands.ALL_FILES_COMMAND, commands.WINDOWS_ALL_FILES_COMMAND)}
            />
          </Deeper>
        </div>
      </section>

      <Panel class="border-orange/25">
        <H id="verify-trust">Keep trust outside this page</H>
        <div class="space-y-3">
          <P>
            This page could itself be tampered with; if in doubt, follow the canonical{' '}
            <Link href={`${REPOSITORY}#verify-this-site`}>README on GitHub</Link>. A “verified”
            badge from this page or our backend would prove nothing against changed frontend code.
          </P>
          <P>
            Attestation proves provenance, not safety. Trust still depends on GitHub, reviewed
            source, your tools and your browser; checking one response does not verify future loads
            or the server’s access rules.
          </P>
          <P>
            For the highest-value keys, encrypt to the recipient’s verified public key first and use
            Brix Share as transport.
          </P>
        </div>
      </Panel>
    </div>
  );
}
