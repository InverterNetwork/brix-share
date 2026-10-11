import { MAX_PAYLOAD_BYTES, MAX_TEXT_BYTES, MAX_VIEWS } from '@brix-share/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { RefreshCw, ShieldCheck } from 'lucide-preact';
import { ApiError, serverNow } from '../api.ts';
import {
  checkContent,
  createFlow,
  fileMeta,
  UploadFailed,
  payloadBytes,
  textBytes,
  type CreatedSecret,
} from '../create-flow.ts';
import {
  assessPassphrase,
  generatePassphrase,
  loadWords,
  type PassphraseAssessment,
} from '../crypto/passphrase.ts';
import { formatBytes, formatDate, fromLocalInput, toLocalInput, viewsLabel } from '../format.ts';
import {
  CUSTOM_MAX_SEC,
  CUSTOM_MIN_SEC,
  DEFAULT_FORM,
  EXPIRY_PRESETS,
  checkPolicy,
  expiryOf,
  maxViewsOf,
  type ExpiryPreset,
  type PolicyForm,
  type ViewsChoice,
} from '../policy.ts';
import { PowCancelled } from '../pow/solve.ts';
import { Dropzone } from '../ui/dropzone.tsx';
import {
  Button,
  CopyButton,
  Field,
  Hint,
  Lede,
  Notice,
  PageTitle,
  Panel,
  PanelTitle,
  Segmented,
  Spinner,
  Switch,
  inputClass,
} from '../ui/kit.tsx';

const VIEW_OPTIONS: { value: ViewsChoice; label: string }[] = [
  { value: 1, label: '1 time' },
  { value: 3, label: '3 times' },
  { value: 10, label: '10 times' },
  { value: 'custom', label: 'Custom' },
  { value: 'unlimited', label: 'Unlimited' },
];

function errorMessage(e: unknown): string {
  if (e instanceof UploadFailed)
    return 'The files could not be uploaded. Nothing was shared; please try again.';
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'create_disabled':
        return e.message;
      case 'network':
        return 'Brix Share could not be reached. Check your connection and try again.';
      case 'invalid_request':
        // Messages raised by our own pre-flight check are already plain sentences.
        return e.status === 0
          ? e.message
          : 'The server did not accept these settings. Check the dates and try again.';
      case 'payload_too_large':
        return 'The secret is too large.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

export function CreateScreen({ onCreated }: { onCreated: (s: CreatedSecret) => void }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [form, setForm] = useState<PolicyForm>(DEFAULT_FORM);
  const [passOn, setPassOn] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [words, setWords] = useState<readonly string[] | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | {
    stage: 'encrypting' | 'solving' | 'sending' | 'uploading';
    tries: number;
    count?: number;
  }>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      cancelRef.current?.();
    },
    [],
  );

  const update = (patch: Partial<PolicyForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  };

  const togglePassphrase = async (on: boolean) => {
    setPassOn(on);
    if (on && !passphrase) {
      const w = words ?? (await loadWords());
      setWords(w);
      const fresh = generatePassphrase(w);
      setGenerated(fresh);
      setPassphrase(fresh);
    }
  };

  const now = serverNow();
  const used = textBytes(text);
  const titleValue = title.trim() === '' ? null : title.trim();
  // Placeholder ids: only the length of the metadata matters for the size check.
  const metas = files.map((f) => fileMeta('A'.repeat(22), f));
  const overPayload = payloadBytes(titleValue, text, metas) > MAX_PAYLOAD_BYTES;
  const strength: PassphraseAssessment | null =
    passOn && words ? assessPassphrase(passphrase, generated, words.length) : null;
  const expiresPreview = expiryOf(form, now);
  const maxViews = maxViewsOf(form);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const contentError = checkContent(titleValue, text, metas);
    const policyError = checkPolicy(form, serverNow());
    const passError =
      passOn && passphrase.trim().length === 0 ? 'Enter a passphrase or switch it off.' : null;
    const first = contentError ?? policyError ?? passError;
    if (first) {
      setError(first);
      return;
    }
    setError(null);
    setBusy({ stage: 'encrypting', tries: 0 });
    try {
      const created = await createFlow(
        { title: titleValue, text, form, passphrase: passOn ? passphrase.trim() : null, files },
        {
          onSolving: (cancel) => {
            cancelRef.current = cancel;
            setBusy({ stage: 'solving', tries: 0 });
          },
          onProgress: (tries) => setBusy({ stage: 'solving', tries }),
          onSubmitting: () => {
            cancelRef.current = null;
            setBusy({ stage: 'sending', tries: 0 });
          },
          check: (now) => checkPolicy(form, now),
          onUploading: (index, count) => setBusy({ stage: 'uploading', tries: index + 1, count }),
        },
      );
      cancelRef.current = null;
      // If the user navigated away meanwhile, stay where they are (the secret exists but its links are gone).
      if (mounted.current) onCreated(created);
    } catch (err) {
      cancelRef.current = null;
      if (!mounted.current) return;
      setBusy(null);
      if (!(err instanceof PowCancelled)) setError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <PageTitle>Share a secret.</PageTitle>
      <Lede>
        Paste a key, a password or a config. It is encrypted in your browser before anything leaves
        it. You get a link for the recipient and a separate link to manage or delete the secret.
      </Lede>
      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel>
          <Field label="Title" hint="optional, encrypted" htmlFor="title">
            <input
              id="title"
              class={inputClass}
              maxLength={200}
              placeholder="e.g. Deployer key for staging"
              value={title}
              onInput={(e) => setTitle(e.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Secret" htmlFor="secret">
            <textarea
              id="secret"
              class={`${inputClass} min-h-[220px] resize-y font-mono text-[13.5px] leading-relaxed sm:min-h-[300px]`}
              value={text}
              onInput={(e) => {
                setText(e.currentTarget.value);
                setError(null);
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellcheck={false}
              aria-describedby="secret-size secret-note"
            />
            <div class="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <Hint>
                <span
                  id="secret-size"
                  class={used > MAX_TEXT_BYTES || overPayload ? 'text-error-fg' : ''}
                >
                  {overPayload && used <= MAX_TEXT_BYTES
                    ? 'Too large once encoded. Shorten it a little.'
                    : `${formatBytes(used)} of 64 KB`}
                </span>
              </Hint>
              <Hint>
                <span id="secret-note">
                  Plain text only. Nothing is formatted or linked on the other side.
                </span>
              </Hint>
            </div>
          </Field>
          <Field label="Files" hint="optional, encrypted, 25 MB total">
            <Dropzone
              files={files}
              disabled={busy !== null}
              onChange={(f) => {
                setFiles(f);
                setError(null);
              }}
            />
          </Field>
        </Panel>

        <div class="flex flex-col gap-4">
          <Panel>
            <PanelTitle>Access</PanelTitle>
            <Field label={<span id="expiry-label">Expires after</span>}>
              <Segmented<ExpiryPreset>
                label="Expires after"
                value={form.expiry}
                options={EXPIRY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                onChange={(v) =>
                  update({
                    expiry: v,
                    customExpiry:
                      v === 'custom' ? (form.customExpiry ?? now + 3 * 86400) : form.customExpiry,
                  })
                }
              />
              {form.expiry === 'custom' && (
                <input
                  type="datetime-local"
                  aria-label="Custom expiry"
                  class={`${inputClass} mt-1`}
                  min={toLocalInput(now + CUSTOM_MIN_SEC)}
                  max={toLocalInput(now + CUSTOM_MAX_SEC)}
                  value={form.customExpiry ? toLocalInput(form.customExpiry) : ''}
                  onInput={(e) => update({ customExpiry: fromLocalInput(e.currentTarget.value) })}
                />
              )}
              <Hint>
                {expiresPreview
                  ? `Expires on ${formatDate(expiresPreview)}. Maximum is 30 days.`
                  : 'Pick a date. Maximum is 30 days.'}
              </Hint>
            </Field>

            <Field label="Can be opened">
              <Segmented<ViewsChoice>
                label="Can be opened"
                value={form.views}
                options={VIEW_OPTIONS}
                onChange={(v) => update({ views: v })}
              />
              {form.views === 'custom' && (
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label="Number of retrievals"
                  class={`${inputClass} mt-1`}
                  min={1}
                  max={MAX_VIEWS}
                  value={form.customViews}
                  onInput={(e) => update({ customViews: Number(e.currentTarget.value) })}
                />
              )}
              <Hint>
                {maxViews === 1
                  ? 'Burn after reading. The link dies after the first retrieval.'
                  : maxViews === null
                    ? 'Can be opened any number of times until it expires.'
                    : `${viewsLabel(maxViews)}, then the link dies.`}
              </Hint>
            </Field>

            <div class="mb-5">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div id="release-label" class="text-[13px] font-medium text-fg-2">
                    Release later
                  </div>
                  <Hint>
                    <span id="release-hint">Not retrievable before a date you set.</span>
                  </Hint>
                </div>
                <Switch
                  checked={form.releaseLater}
                  labelledBy="release-label"
                  describedBy="release-hint"
                  onChange={(v) =>
                    update({
                      releaseLater: v,
                      availableFrom: v ? (form.availableFrom ?? now + 3600) : form.availableFrom,
                    })
                  }
                />
              </div>
              {form.releaseLater && (
                <input
                  type="datetime-local"
                  aria-label="Available from"
                  class={`${inputClass} mt-2`}
                  min={toLocalInput(now + 120)}
                  max={expiresPreview ? toLocalInput(expiresPreview - 6 * 60) : undefined}
                  value={form.availableFrom ? toLocalInput(form.availableFrom) : ''}
                  onInput={(e) => update({ availableFrom: fromLocalInput(e.currentTarget.value) })}
                />
              )}
            </div>

            <div>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div id="pass-label" class="text-[13px] font-medium text-fg-2">
                    Passphrase
                  </div>
                  <Hint>
                    <span id="pass-hint">
                      Extra layer for highly sensitive secrets. A second secret you pass on over a
                      second channel, so the link alone is not enough.
                    </span>
                  </Hint>
                </div>
                <Switch
                  checked={passOn}
                  labelledBy="pass-label"
                  describedBy="pass-hint"
                  onChange={(v) => void togglePassphrase(v)}
                />
              </div>
              {passOn && (
                <div class="mt-3 flex flex-col gap-2">
                  {/* A textarea so a five-word phrase wraps on narrow screens instead of scrolling out of view. */}
                  <textarea
                    aria-label="Passphrase"
                    rows={2}
                    class={`${inputClass} resize-none font-mono text-sm break-all`}
                    value={passphrase}
                    onInput={(e) => setPassphrase(e.currentTarget.value.replace(/[\r\n]/g, ''))}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellcheck={false}
                  />
                  <div class="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!words) return;
                        const fresh = generatePassphrase(words);
                        setGenerated(fresh);
                        setPassphrase(fresh);
                      }}
                    >
                      <RefreshCw aria-hidden="true" />
                      New phrase
                    </Button>
                    <CopyButton text={passphrase} label="Copy" />
                  </div>
                  {strength && (
                    <div aria-live="polite">
                      {strength.kind === 'generated' ? (
                        <>
                          <div class="mb-1 flex h-1 gap-1" aria-hidden="true">
                            {[0, 1, 2].map((i) => (
                              <span key={i} class="flex-1 rounded-pill bg-success" />
                            ))}
                          </div>
                          <Hint>{`Generated at random, about ${strength.bits} bits. You can type your own instead.`}</Hint>
                        </>
                      ) : (
                        <Hint class="text-error-fg">
                          {strength.tooShort
                            ? 'Too short. Anyone holding the link can guess a short passphrase offline. Use the generated one.'
                            : 'Your own passphrase. Its strength cannot be judged from the text, and anyone holding the link can try guesses offline. Use the generated one unless yours is long and random.'}
                        </Hint>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            {error && (
              <div class="mb-4">
                <Notice tone="error" role="alert">
                  {error}
                </Notice>
              </div>
            )}
            <p class="mb-4 text-xs leading-relaxed text-fg-3">
              By creating a secret you confirm that it complies with our{' '}
              {/* A new tab, so the form keeps what was typed. */}
              <a
                href="/acceptable-use"
                target="_blank"
                rel="noopener"
                class="text-white underline underline-offset-2"
              >
                Acceptable use policy
              </a>
              .
            </p>
            {busy ? (
              <div class="flex flex-col items-center gap-3" role="status" aria-live="polite">
                <Button variant="primary" size="lg" block disabled>
                  <Spinner />
                  {busy.stage === 'encrypting' ? 'Encrypting' : 'Preparing secure link'}
                </Button>
                <Hint class="text-center">
                  {busy.stage === 'solving'
                    ? `A short anti-abuse check runs in your browser${busy.tries > 0 ? ` (${(busy.tries / 1000).toFixed(0)}k tries)` : ''}.`
                    : busy.stage === 'sending'
                      ? 'Storing the encrypted secret.'
                      : busy.stage === 'uploading'
                        ? `Uploading encrypted file ${busy.tries} of ${busy.count ?? 1}.`
                        : 'Encrypting in your browser.'}
                </Hint>
                {busy.stage === 'solving' && (
                  <Button variant="ghost" size="sm" onClick={() => cancelRef.current?.()}>
                    Cancel
                  </Button>
                )}
              </div>
            ) : (
              <Button type="submit" variant="primary" size="lg" block>
                Create secure link
              </Button>
            )}
            <p class="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
              <ShieldCheck aria-hidden="true" class="mt-[3px] size-3.5 flex-none" />
              <span>
                Encrypted with AES-256-GCM in your browser. The key is never sent to Brix.
              </span>
            </p>
          </Panel>
        </div>
      </div>
    </form>
  );
}
