import { b64urlDecode, isoToSec, type Envelope, type Payload } from '@brix-share/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  AlertTriangle,
  Clock,
  Download,
  EyeOff,
  FileText,
  KeyRound,
  Lock,
  Unlink,
} from 'lucide-preact';
import { ApiError, NetworkError, consumeSecret, getAvailability } from '../api.ts';
import {
  DecryptError,
  ProtocolError,
  checkEnvelope,
  deriveKey,
  deriveConsumeToken,
  envelopeSalt,
  openText,
} from '../crypto/envelope.ts';
import { formatBytes, formatDate } from '../format.ts';
import { setLeaveGuard } from '../leave-guard.ts';
import {
  decryptFiles,
  fetchEncryptedFiles,
  revokeFiles,
  type RevealedFile,
} from '../attachments.ts';
import { Countdown } from '../ui/countdown.tsx';
import {
  Button,
  CopyButton,
  Field,
  Hint,
  HeroIcon,
  Notice,
  Panel,
  PageTitle,
  Spinner,
  inputClass,
} from '../ui/kit.tsx';

type State =
  | { kind: 'checking' }
  | { kind: 'intro' }
  | { kind: 'loading' }
  | { kind: 'fetching'; count: number }
  | { kind: 'too_early'; availableFrom: number }
  | { kind: 'passphrase'; envelope: Envelope; policy: Policy; wrong: boolean; working: boolean }
  | { kind: 'revealed'; payload: Payload; policy: Policy; files: RevealedFile[] }
  | { kind: 'cleared' }
  | { kind: 'gone' }
  | { kind: 'lost' }
  | { kind: 'broken'; reason: 'key' | 'protocol' }
  | { kind: 'error'; message: string };

interface Policy {
  viewsRemaining: number | null;
  expiresAt: string;
}

function Centered({ children }: { children: preact.ComponentChildren }) {
  return (
    <div class="mx-auto max-w-[560px]">
      <Panel class="sm:p-8">{children}</Panel>
    </div>
  );
}

const Footnote = ({ children }: { children: preact.ComponentChildren }) => (
  <p class="mt-4 text-center text-xs text-muted">{children}</p>
);

export function RevealScreen({
  id,
  linkKey,
  onNew,
}: {
  id: string;
  linkKey: string | null;
  onNew: () => void;
}) {
  const [state, setState] = useState<State>(
    linkKey ? { kind: 'checking' } : { kind: 'broken', reason: 'key' },
  );
  const [confirmClear, setConfirmClear] = useState(false);
  const clearGroup = useRef<HTMLDivElement>(null);
  // The confirmation replaces the button that opened it: move focus to the safe choice.
  useEffect(() => {
    if (confirmClear) clearGroup.current?.querySelector<HTMLElement>('[data-safe]')?.focus();
  }, [confirmClear]);
  const [pass, setPass] = useState('');
  const keyBytes = useRef(linkKey ? b64urlDecode(linkKey) : null);
  // Encrypted attachments between the consume and decryption; never in state, never persisted.
  const encryptedFiles = useRef<(Uint8Array<ArrayBuffer> | null)[]>([]);
  // From the moment the consume is sent: closing the tab mid-request may still burn the retrieval.
  const holding =
    state.kind === 'loading' ||
    state.kind === 'fetching' ||
    state.kind === 'passphrase' ||
    state.kind === 'revealed';

  // While a retrieved secret exists only in this tab, leaving needs a confirmation.
  useEffect(() => {
    setLeaveGuard(
      holding
        ? 'The secret exists only on this page now. If you leave, it is gone. Leave anyway?'
        : null,
    );
  }, [holding]);
  useEffect(() => () => setLeaveGuard(null), []);

  // Whether the link can still be opened, before anyone clicks: a deleted, used up or expired secret shows as
  // gone at once. Counts nothing; if the check fails, the reveal button decides as before.
  const check = async () => {
    setState({ kind: 'checking' });
    try {
      const a = await getAvailability(id, await deriveConsumeToken(keyBytes.current!));
      setState(
        a.kind === 'not_found'
          ? { kind: 'gone' }
          : a.kind === 'too_early'
            ? { kind: 'too_early', availableFrom: isoToSec(a.availableFrom) }
            : { kind: 'intro' },
      );
    } catch {
      setState({ kind: 'intro' });
    }
  };
  useEffect(() => {
    if (linkKey) void check();
  }, []);

  if (!linkKey) {
    return (
      <Centered>
        <HeroIcon>
          <Unlink />
        </HeroIcon>
        <PageTitle>This link is incomplete.</PageTitle>
        <p class="text-fg-3">
          Ask the sender to resend it in full. If you came back to this tab after a while, open the
          original link again: the key is removed from the address bar once the page has read it.
          Nothing has been retrieved.
        </p>
      </Centered>
    );
  }

  const decrypt = async (envelope: Envelope, policy: Policy, passphrase: string | null) => {
    const key = await deriveKey(keyBytes.current!, passphrase, envelopeSalt(envelope));
    const payload = await openText(envelope, key);
    const files = await decryptFiles(id, payload, encryptedFiles.current);
    encryptedFiles.current = [];
    setState({ kind: 'revealed', payload, policy, files });
  };

  const reveal = async () => {
    setState({ kind: 'loading' });
    let outcome;
    try {
      outcome = await consumeSecret(id, await deriveConsumeToken(keyBytes.current!));
    } catch (e) {
      // The request may have reached the server and counted (dropped connection, or a server error after an
      // ambiguous write). Never retry, not even on a click.
      const ambiguous =
        e instanceof NetworkError ||
        !(e instanceof ApiError) ||
        e.status >= 500 ||
        e.code === 'unexpected';
      setState(ambiguous ? { kind: 'lost' } : { kind: 'error', message: e.message });
      return;
    }
    if (outcome.kind === 'not_found') {
      setState({ kind: 'gone' });
      return;
    }
    if (outcome.kind === 'too_early') {
      setState({ kind: 'too_early', availableFrom: isoToSec(outcome.availableFrom) });
      return;
    }
    const policy = outcome.data.policy;
    let envelope: Envelope;
    try {
      envelope = checkEnvelope(outcome.data.envelope, id);
    } catch {
      setState({ kind: 'broken', reason: 'protocol' });
      return;
    }
    // Fetch the encrypted files now: their URLs live 2 minutes, a passphrase prompt may take longer. The
    // retrieval is already counted, so leaving from here on needs a confirmation too.
    if (outcome.data.downloads.length > 0)
      setState({ kind: 'fetching', count: outcome.data.downloads.length });
    try {
      encryptedFiles.current = await fetchEncryptedFiles(id, envelope, outcome.data.downloads);
    } catch {
      setState({ kind: 'broken', reason: 'protocol' });
      return;
    }
    if (envelope.hasPassphrase) {
      setState({ kind: 'passphrase', envelope, policy, wrong: false, working: false });
      return;
    }
    try {
      await decrypt(envelope, policy, null);
    } catch (e) {
      setState({ kind: 'broken', reason: e instanceof DecryptError ? 'key' : 'protocol' });
    }
  };

  const submitPassphrase = async (e: Event) => {
    e.preventDefault();
    if (state.kind !== 'passphrase' || state.working) return;
    setState({ ...state, working: true, wrong: false });
    try {
      await decrypt(state.envelope, state.policy, pass);
      setPass('');
    } catch (err) {
      if (err instanceof ProtocolError) setState({ kind: 'broken', reason: 'protocol' });
      else setState({ ...state, working: false, wrong: true });
    }
  };

  switch (state.kind) {
    case 'fetching':
      return (
        <Centered>
          <HeroIcon>
            <Lock />
          </HeroIcon>
          <PageTitle>Fetching the encrypted files.</PageTitle>
          <p class="flex items-center gap-3 text-fg-3" role="status">
            <Spinner />
            {state.count === 1 ? '1 file' : `${state.count} files`}. Keep this tab open: the secret
            has been retrieved.
          </p>
        </Centered>
      );
    case 'checking':
      return (
        <Centered>
          <HeroIcon>
            <Lock />
          </HeroIcon>
          <PageTitle>You have been sent a secret.</PageTitle>
          <p class="flex items-center gap-3 text-fg-3" role="status">
            <Spinner /> Checking the link
          </p>
        </Centered>
      );
    case 'intro':
    case 'loading':
      return (
        <Centered>
          <HeroIcon>
            <Lock />
          </HeroIcon>
          <PageTitle>You have been sent a secret.</PageTitle>
          <p class="mb-6 text-fg-3">
            Opening it counts as a retrieval. If the sender chose burn after reading, this is the
            only chance to see it, so make sure you are ready to save it.
          </p>
          <Button
            variant="primary"
            size="lg"
            block
            onClick={() => void reveal()}
            disabled={state.kind === 'loading'}
          >
            {state.kind === 'loading' ? <Spinner /> : null}
            Reveal secret
          </Button>
          <Footnote>Decrypted in your browser. Brix never sees the content.</Footnote>
        </Centered>
      );
    case 'too_early':
      return (
        <Centered>
          <HeroIcon>
            <Clock />
          </HeroIcon>
          <PageTitle>Not yet available.</PageTitle>
          <p class="text-fg-3">
            The sender scheduled this secret for{' '}
            <b class="font-mono font-medium text-white">{formatDate(state.availableFrom)}</b>. Come
            back then. Nothing has been retrieved.
          </p>
          <Countdown targetSec={state.availableFrom} />
          <Button block onClick={() => void check()}>
            Try again
          </Button>
        </Centered>
      );
    case 'passphrase':
      return (
        <Centered>
          <HeroIcon>
            <KeyRound />
          </HeroIcon>
          <PageTitle>Enter the passphrase.</PageTitle>
          <p class="mb-6 text-fg-3">
            The secret has been retrieved and is held in this tab. Enter the passphrase the sender
            gave you to decrypt it. You can retry without losing it.
          </p>
          <form onSubmit={(e) => void submitPassphrase(e)}>
            <Field label="Passphrase" htmlFor="passphrase">
              <input
                id="passphrase"
                class={`${inputClass} font-mono`}
                value={pass}
                onInput={(e) => setPass(e.currentTarget.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellcheck={false}
                aria-invalid={state.wrong}
                aria-describedby={state.wrong ? 'pass-error' : undefined}
              />
            </Field>
            {state.wrong && (
              <div id="pass-error" class="mb-4">
                <Notice tone="error" role="alert" icon={<AlertTriangle />}>
                  That passphrase did not decrypt the secret. Check it and try again.
                </Notice>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              disabled={state.working || pass.length === 0}
            >
              {state.working ? <Spinner /> : null}
              Decrypt
            </Button>
          </form>
          <Footnote>Do not close this tab: the secret cannot be retrieved again.</Footnote>
        </Centered>
      );
    case 'revealed': {
      const { payload, policy } = state;
      const left = policy.viewsRemaining;
      const clear = () => {
        // Drop the plaintext and the link key from memory, not only from the screen.
        keyBytes.current = null;
        revokeFiles(state.files);
        setConfirmClear(false);
        setState({ kind: 'cleared' });
      };
      return (
        <div class="mx-auto max-w-[760px]">
          <Panel>
            <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h1 class="text-base font-semibold break-words">{payload.title ?? 'Secret'}</h1>
              <span class="text-xs text-muted">Decrypted</span>
            </div>
            {payload.text.length > 0 && (
              <textarea
                readOnly
                aria-label="Secret"
                class="block max-h-[60vh] min-h-[200px] w-full resize-y rounded-sm border border-line bg-[#0a0a0a] p-4 font-mono text-[13.5px] leading-relaxed text-fg-2 outline-none focus:border-orange"
                value={payload.text}
                spellcheck={false}
              />
            )}
            {payload.text.length > 0 && (
              <div class="mt-3 flex items-center justify-between gap-3">
                <CopyButton text={payload.text} />
                <Hint>{formatBytes(new TextEncoder().encode(payload.text).length)}</Hint>
              </div>
            )}
            {state.files.length > 0 && (
              <div class="mt-5">
                <h2 class="mb-2 text-sm font-semibold">Files</h2>
                <ul class="flex flex-col gap-2" aria-label="Files">
                  {state.files.map((f, i) => (
                    <li
                      key={i}
                      class="flex items-center gap-2.5 rounded-sm border border-line bg-field py-1.5 pr-1.5 pl-3 text-[13px]"
                    >
                      <FileText aria-hidden="true" class="size-4 flex-none text-fg-3" />
                      <span class="min-w-0 flex-1 truncate text-fg-2">{f.name}</span>
                      <span class="flex-none font-mono text-xs text-muted">
                        {formatBytes(f.size)}
                      </span>
                      {f.url ? (
                        <a
                          href={f.url}
                          download={f.name}
                          class="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-line-mid px-4 text-[13px] font-medium text-white hover:border-line-strong sm:min-h-9"
                        >
                          <Download aria-hidden="true" class="size-4" />
                          Download
                        </a>
                      ) : (
                        <span class="px-2 text-xs text-error-fg">Could not be fetched</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div class="mt-5">
              <Notice icon={<AlertTriangle />}>
                {state.files.length > 0 ? 'Download the files before you leave this page. ' : ''}
                {left === 0
                  ? state.files.length > 0
                    ? 'This was the only retrieval. The text is gone from our servers; the encrypted files are deleted within minutes. Copy and save what you need before you leave this page.'
                    : 'This was the only retrieval. The secret no longer exists on our servers. Copy what you need before you leave this page.'
                  : left === null
                    ? `This link keeps working until ${formatDate(policy.expiresAt)}.`
                    : `This link can be opened ${left} more ${left === 1 ? 'time' : 'times'}, until ${formatDate(policy.expiresAt)}.`}
              </Notice>
            </div>
            {confirmClear ? (
              <div
                ref={clearGroup}
                class="mt-6 flex flex-col gap-2"
                role="group"
                aria-label="Confirm clearing"
              >
                <Notice tone="error" role="alert" icon={<AlertTriangle />}>
                  {left === 0
                    ? 'This was the last retrieval. Once cleared, nobody can open this secret again, you included.'
                    : `You may not be able to see this again: the link can be opened ${left} more ${left === 1 ? 'time' : 'times'}, and others may use them up.`}
                </Notice>
                <div class="flex flex-col gap-2 sm:flex-row">
                  <Button variant="danger" onClick={clear}>
                    <EyeOff aria-hidden="true" />
                    Clear anyway
                  </Button>
                  <Button variant="ghost" data-safe onClick={() => setConfirmClear(false)}>
                    Keep it on screen
                  </Button>
                </div>
              </div>
            ) : (
              <div class="mt-6 flex flex-col gap-2 sm:flex-row">
                <Button onClick={() => (left === null ? clear() : setConfirmClear(true))}>
                  <EyeOff aria-hidden="true" />
                  Clear from screen
                </Button>
                <Button variant="ghost" onClick={onNew}>
                  Send a secret back
                </Button>
              </div>
            )}
          </Panel>
        </div>
      );
    }
    case 'cleared':
      return (
        <Centered>
          <PageTitle>Cleared.</PageTitle>
          <p class="mb-6 text-fg-3">The secret is no longer on this page.</p>
          <Button onClick={onNew}>Create a secret</Button>
        </Centered>
      );
    case 'gone':
      return (
        <Centered>
          <HeroIcon>
            <Unlink />
          </HeroIcon>
          <PageTitle>This secret is not available.</PageTitle>
          <p class="text-fg-3">
            It does not exist or can no longer be opened: it was already retrieved, it expired, or
            the sender deleted it. Ask the sender for a new link.
          </p>
        </Centered>
      );
    case 'lost':
      return (
        <Centered>
          <HeroIcon>
            <AlertTriangle />
          </HeroIcon>
          <PageTitle>The secret could not be shown.</PageTitle>
          <p class="text-fg-3">
            The connection failed or the server had a problem. The secret may have been retrieved
            and counted anyway. To keep one-time links safe, it is not requested again. Ask the
            sender to check their manage page and, if needed, send a new link.
          </p>
        </Centered>
      );
    case 'broken':
      return (
        <Centered>
          <HeroIcon>
            <AlertTriangle />
          </HeroIcon>
          <PageTitle>
            {state.reason === 'key'
              ? 'This link does not open the secret.'
              : 'This secret cannot be read.'}
          </PageTitle>
          <p class="text-fg-3">
            {state.reason === 'key'
              ? 'The key in the link does not match. The link may be incomplete or altered. The retrieval has been counted; ask the sender to create a new secret and send the link in full.'
              : 'The secret is in a format this page does not support, or it does not belong to this link. Ask the sender to create a new one.'}
          </p>
        </Centered>
      );
    case 'error':
      return (
        <Centered>
          <PageTitle>Something went wrong.</PageTitle>
          <p class="text-fg-3">
            {state.message} Ask the sender for a new link if this keeps happening.
          </p>
        </Centered>
      );
  }
}
