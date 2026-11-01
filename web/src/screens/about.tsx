import type { ComponentChildren } from 'preact';
import { Lede, PageTitle, Panel } from '../ui/kit.tsx';

export const CONTACT_EMAIL = 'security@brix.money';

const H = ({ children, id }: { children: ComponentChildren; id?: string }) => (
  <h2 id={id} class="mb-3 text-lg font-semibold text-white">
    {children}
  </h2>
);
const P = ({ children }: { children: ComponentChildren }) => (
  <p class="mb-3 text-[15px] leading-relaxed text-fg-3 last:mb-0">{children}</p>
);
const Li = ({ children }: { children: ComponentChildren }) => (
  <li class="mb-2 text-[15px] leading-relaxed text-fg-3">{children}</li>
);

export function HowItWorksScreen() {
  return (
    <div class="max-w-[760px]">
      <PageTitle>How Brix Share works.</PageTitle>
      <Lede>
        Secrets are encrypted in your browser. The server stores only ciphertext and hands it out as
        often as you allowed, then deletes it.
      </Lede>
      <div class="flex flex-col gap-4">
        <Panel>
          <H>What happens to a secret</H>
          <P>
            Your browser generates a random 256-bit key and encrypts the title, the text and any
            file names with AES-256-GCM. The key goes into the part of the link after the #, which
            browsers never send to a server. Brix stores the ciphertext, the policy you chose and a
            hash of each of the separate manage and retrieval tokens. Each attachment has its own
            random key, held inside the encrypted text. A link leaked after the text is gone cannot
            unlock leftover file objects.
          </P>
          <P>
            A secret ends after its last allowed retrieval, at its expiry, or when you delete it.
            The encrypted text is removed at that moment (at expiry within a few minutes); encrypted
            files go within minutes after the end, or at once on delete. Expiry is capped at 30
            days.
          </P>
        </Panel>
        <Panel>
          <H>What it protects against</H>
          <ul class="list-disc pl-5">
            <Li>A leak of our database, backups or logs: they contain ciphertext only.</Li>
            <Li>A compromise of our servers that cannot change the page your browser loads.</Li>
            <Li>
              A burn-after-reading link that leaks after it was opened: it no longer works. A
              passphrase covers leaks of multi-view links.
            </Li>
            <Li>Guessing: links use 128-bit random ids and 256-bit random keys.</Li>
          </ul>
        </Panel>
        <Panel>
          <H>What it does not protect against</H>
          <ul class="list-disc pl-5">
            <Li>
              Someone who can change the web page itself (our hosting, our deploy pipeline, or an
              administrator of the account) could read secrets as they are typed or opened. For
              custody or production signing keys, encrypt to the recipient's verified public key
              first and use Brix Share only as transport.
            </Li>
            <Li>
              The access rules themselves if our servers were compromised: view limits, release
              dates, expiry and deletion are enforced by the server. Someone in control of it could
              keep the encrypted data or hand it out again; they would still need the key from the
              link (and the passphrase, if you set one) to read it.
            </Li>
            <Li>
              Retrievals used up by a full-link holder: anyone with the complete share link can use
              up retrievals even without the optional passphrase. Knowing only the address before
              the # cannot retrieve the secret or check its availability. The manage page shows
              every retrieval with time and country.
            </Li>
            <Li>
              Identity: holding a link proves nothing about who sent or received it. Verify
              important exchanges over a channel you trust.
            </Li>
            <Li>
              What the recipient does: a retrieval means the server released the ciphertext once,
              not that one person read it.
            </Li>
            <Li>
              Weak passphrases: anyone holding the full link can try guesses offline. Use the
              generated passphrase.
            </Li>
          </ul>
        </Panel>
        <Panel>
          <H>Link previews</H>
          <P>
            Chat apps and mail scanners fetch links to show previews. Loading a share link does not
            count as a retrieval: it is retrieved only when the recipient clicks Reveal secret. The
            request carries a retrieval token derived from the link key, independently of any
            passphrase. A scanner that runs JavaScript and clicks Reveal with the full link can
            still retrieve it. The manage page shows the time and country of every retrieval, so an
            unexpected one stands out.
          </P>
        </Panel>
        <Contact />
      </div>
    </div>
  );
}

function Contact() {
  return (
    <Panel>
      <H>Contact</H>
      <P>
        Questions or a security issue:{' '}
        <a class="text-white underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        .
      </P>
    </Panel>
  );
}

export function PrivacyScreen() {
  return (
    <div class="max-w-[760px]">
      <PageTitle>Privacy.</PageTitle>
      <Lede>
        No accounts, no cookies, no analytics, no third-party requests. We cannot read your secrets,
        and we keep as little about them as the service needs.
      </Lede>
      <div class="flex flex-col gap-4">
        <Panel>
          <H>What we store</H>
          <ul class="list-disc pl-5">
            <Li>The encrypted secret and encrypted files. We cannot read them.</Li>
            <Li>The policy you chose: expiry, number of retrievals, release date.</Li>
            <Li>The time and country of each retrieval, shown on the manage page.</Li>
            <Li>A hash of the manage token, to check the manage link.</Li>
          </ul>
          <P>No names, no accounts, no IP addresses in our database.</P>
        </Panel>
        <Panel>
          <H>How long</H>
          <P>
            The encrypted secret is deleted when it ends: after its last retrieval, at expiry, or
            when you delete it. Encrypted files follow within minutes. A metadata-only history
            (times, countries, why it ended) stays readable through the manage link for 30 days
            after that, then it is deleted too. There are no backups.
          </P>
        </Panel>
        <Panel>
          <H>Access logs</H>
          <P>
            Like any public website, our content delivery network keeps access logs with IP
            addresses, time and requested path for 30 days, for security and abuse investigation.
            They never contain the keys: the part of a link after the # is not sent to any server.
            Access to the logs is restricted and they are never shown to other users.
          </P>
        </Panel>
        <Panel>
          <H>Authorities</H>
          <P>
            We share information with authorities only when the law requires it, or to report
            suspected illegal use as described in the{' '}
            <a class="text-white underline" href="/acceptable-use">
              Acceptable use policy
            </a>
            . We can only share what is listed on this page; never the content or the keys, which we
            do not have.
          </P>
        </Panel>
        <Panel>
          <H>In your browser</H>
          <P>
            No cookies, no analytics, no third-party requests. Keys stay in memory only, with one
            exception: a manage page keeps its manage token in the tab's session storage, so
            reloading the page works. Browsers drop it with the tab, unless they restore closed
            tabs.
          </P>
        </Panel>
        <Contact />
      </div>
    </div>
  );
}

export function AcceptableUseScreen() {
  return (
    <div class="max-w-[760px]">
      <PageTitle>Acceptable use.</PageTitle>
      <Lede>
        Brix Share is for passing on information you are allowed to share, such as credentials,
        keys, configuration and documents. By creating a secret you confirm that it complies with
        this policy.
      </Lede>
      <div class="flex flex-col gap-4">
        <Panel>
          <H>What it is for</H>
          <P>
            Sharing passwords, API keys, private keys, configuration files and documents that you
            have the right to share, with people who should receive them.
          </P>
        </Panel>
        <Panel>
          <H>What is not allowed</H>
          <P>You must not use Brix Share to store or share:</P>
          <ul class="list-disc pl-5">
            <Li>
              Anything that is illegal under the law that applies to you, to the recipient or to us.
            </Li>
            <Li>
              Material that infringes copyright or other rights of others, such as pirated software,
              films, music or books.
            </Li>
            <Li>Child sexual abuse material, or any other content whose possession is a crime.</Li>
            <Li>
              Malware, phishing pages, exploits used against systems you are not authorised to test,
              or anything else meant to harm people or systems.
            </Li>
            <Li>
              Stolen credentials, leaked databases or personal data you have no legal basis to
              share.
            </Li>
            <Li>Content used for fraud, threats, harassment or extortion.</Li>
          </ul>
          <P>
            You must also not overload or attack the service, get around its rate limits or
            anti-abuse checks, or use it in an automated way at scale.
          </P>
        </Panel>
        <Panel>
          <H>Your responsibility</H>
          <P>
            Secrets are encrypted in your browser, so we cannot see what you share. You are
            responsible for the content you create and for whom you send the link.
          </P>
        </Panel>
        <Panel>
          <H>Reports and removal</H>
          <P>
            If you believe a Brix Share link is being used against this policy, send it to{' '}
            <a class="text-white underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            . The part of the link before the # is enough; please do not send the key.
          </P>
          <P>
            We reserve the right to delete any secret, without notice, that is reported to us or
            that we reasonably suspect of breaking this policy or the law, and to block access to
            the service.
          </P>
        </Panel>
        <Panel>
          <H>Authorities</H>
          <P>
            We reserve the right to report suspected illegal use to the competent authorities and to
            cooperate with them. We hand over information when the law requires it or when we report
            illegal use. We can only provide what we hold (see{' '}
            <a class="text-white underline" href="/privacy">
              Privacy
            </a>
            ): the encrypted data, its settings, the time and country of each retrieval, and access
            logs with IP addresses for 30 days. We cannot decrypt secrets: the key is never sent to
            us.
          </P>
        </Panel>
        <Panel>
          <H>Changes</H>
          <P>
            We may update this policy. The version on this page applies. Last updated 10 October
            2026.
          </P>
        </Panel>
        <Contact />
      </div>
    </div>
  );
}

export function NotFoundScreen({ onHome }: { onHome: () => void }) {
  return (
    <div class="max-w-[560px]">
      <PageTitle>Page not found.</PageTitle>
      <p class="mb-6 text-fg-3">There is nothing at this address.</p>
      <button type="button" class="text-white underline" onClick={onHome}>
        Share a secret
      </button>
    </div>
  );
}
