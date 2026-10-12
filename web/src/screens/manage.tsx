import type { StatusResponse } from '@brix-share/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, RefreshCw, Trash2, Unlink } from 'lucide-preact';
import { deleteSecret, getStatus } from '../api.ts';
import { formatDate, formatDateSeconds, viewsLabel } from '../format.ts';
import {
  Button,
  Chip,
  Hint,
  HeroIcon,
  KeyValues,
  Lede,
  Notice,
  PageTitle,
  Panel,
  PanelTitle,
  Spinner,
} from '../ui/kit.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; status: StatusResponse; justDeleted: boolean }
  | { kind: 'error' };

const REASON: Record<string, string> = {
  consumed: 'Retrieved',
  expired: 'Expired',
  deleted: 'Deleted by you',
};

function statusLine(s: StatusResponse): string {
  if (s.status === 'ended') {
    if (s.endedReason === 'consumed')
      return s.maxViews === 1
        ? 'Ended · opened 1 time'
        : `Ended · opened ${s.retrievalCount} times`;
    return `Ended · ${REASON[s.endedReason ?? ''] ?? 'ended'}`;
  }
  if (s.status === 'pending') return 'Pending · uploading files';
  if (s.viewsRemaining !== null && s.maxViews !== null)
    return `Live · ${s.viewsRemaining} of ${s.maxViews} retrievals left`;
  return `Live · opened ${s.retrievalCount} ${s.retrievalCount === 1 ? 'time' : 'times'}`;
}

/**
 * The manage token of the open manage page, kept in this tab's sessionStorage so a reload still works after
 * the fragment was removed from the address bar. Closing the tab forgets it. Never used for share-link keys.
 */
const storageKey = (id: string) => `brix-share:manage:${id}`;
function rememberToken(id: string, token: string | null): string | null {
  try {
    if (token) sessionStorage.setItem(storageKey(id), token);
    return token ?? sessionStorage.getItem(storageKey(id));
  } catch {
    return token;
  }
}
function forgetToken(id: string): void {
  try {
    sessionStorage.removeItem(storageKey(id));
  } catch {
    // Storage disabled: nothing was kept.
  }
}

export function ManageScreen({
  id,
  token: fromLink,
  onNew,
}: {
  id: string;
  token: string | null;
  onNew: () => void;
}) {
  const [token] = useState(() => rememberToken(id, fromLink));
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<State>(token ? { kind: 'loading' } : { kind: 'missing' });
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteGroup = useRef<HTMLDivElement>(null);
  // Answers that arrive after a newer request started are dropped (a slow refresh racing a delete).
  const latest = useRef(0);
  useEffect(() => {
    if (confirming) deleteGroup.current?.querySelector<HTMLElement>('[data-safe]')?.focus();
  }, [confirming]);

  const load = async (justDeleted = false, keepOnError = false) => {
    if (!token) return;
    const n = ++latest.current;
    try {
      const status = await getStatus(id, token);
      if (n !== latest.current) return;
      if (!status) forgetToken(id);
      setState(status ? { kind: 'ready', status, justDeleted } : { kind: 'missing' });
    } catch {
      // A failed refresh keeps what is on screen; a failed first load shows the error.
      if (n === latest.current && !keepOnError) setState({ kind: 'error' });
    }
  };

  useEffect(() => {
    void load();
  }, [id, token]);

  const refresh = async () => {
    setRefreshing(true);
    await load(state.kind === 'ready' && state.justDeleted, true);
    setRefreshing(false);
  };

  const doDelete = async () => {
    if (!token) return;
    setDeleting(true);
    try {
      const deleted = await deleteSecret(id, token);
      setConfirming(false);
      await load(deleted);
    } catch {
      latest.current++;
      setState({ kind: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div class="flex items-center gap-3 text-fg-3" role="status">
        <Spinner /> Loading
      </div>
    );
  }
  if (state.kind === 'missing') {
    return (
      <div class="mx-auto max-w-[560px]">
        <Panel class="sm:p-8">
          <HeroIcon>
            <Unlink />
          </HeroIcon>
          <PageTitle>Nothing found for this manage link.</PageTitle>
          <p class="text-fg-3">
            The link may be incomplete, or the history was removed 30 days after the secret ended.
            If you came back to this tab after a while, open the manage link again.
          </p>
        </Panel>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div class="mx-auto max-w-[560px]">
        <Panel class="sm:p-8">
          <PageTitle>Something went wrong.</PageTitle>
          <p class="mb-6 text-fg-3">The status could not be loaded. Try again in a moment.</p>
          <Button onClick={() => void load()}>Try again</Button>
        </Panel>
      </div>
    );
  }

  const s = state.status;
  const ended = s.status === 'ended';
  const rows: [string, preact.ComponentChildren, boolean?][] = [
    ['Secret', id, true],
    ['Created', formatDate(s.createdAt)],
  ];
  if (ended && s.endedAt) {
    rows.push(['Ended', formatDate(s.endedAt)]);
    rows.push(['Reason', REASON[s.endedReason ?? ''] ?? '']);
    rows.push(['Was set to expire', formatDate(s.expiresAt)]);
  } else {
    rows.push(['Expires', formatDate(s.expiresAt)]);
  }
  rows.push(['Can be opened', viewsLabel(s.maxViews)]);
  rows.push(['Release', s.availableFrom ? formatDate(s.availableFrom) : 'Immediately']);
  rows.push(['Passphrase', s.hasPassphrase ? 'Yes' : 'No']);
  if (s.fileCount > 0) {
    rows.push([
      'Files',
      `${s.fileCount} ${s.fileCount === 1 ? 'attachment' : 'attachments'}${ended ? ', deleted' : ''}`,
    ]);
  }

  return (
    <div>
      <PageTitle>Manage secret.</PageTitle>
      {ended ? (
        <Lede>
          {state.justDeleted
            ? 'Deleted. Nothing remains on our servers. '
            : 'This secret has ended. '}
          Nothing remains on our servers except this history, which disappears on{' '}
          {s.historyUntil ? formatDate(s.historyUntil) : 'its removal date'}.
        </Lede>
      ) : (
        <Lede>
          Only you have this link. It shows what happened to the secret and lets you delete it. It
          never reveals the content.
        </Lede>
      )}
      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div class="flex flex-col gap-4">
          <Panel>
            <div class="mb-5 flex flex-wrap items-center gap-3">
              <span class="text-sm font-semibold">Status</span>
              <Chip tone={ended ? 'off' : 'ok'}>{statusLine(s)}</Chip>
              <span class="ml-auto">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void refresh()}
                  disabled={refreshing || confirming || deleting}
                >
                  {refreshing ? <Spinner /> : <RefreshCw aria-hidden="true" />}
                  Refresh
                </Button>
              </span>
            </div>
            <KeyValues rows={rows} />
          </Panel>
          <Panel>
            <PanelTitle hint="time and country only, no IP addresses">Retrievals</PanelTitle>
            {s.retrievals.length === 0 ? (
              <Hint>Not opened yet.</Hint>
            ) : (
              <div class="overflow-x-auto">
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr class="border-b border-line-soft text-left text-muted">
                      <th scope="col" class="pb-2.5 font-medium">
                        #
                      </th>
                      <th scope="col" class="pb-2.5 font-medium">
                        When
                      </th>
                      <th scope="col" class="pb-2.5 font-medium">
                        From
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.retrievals.map((r, i) => (
                      <tr key={i} class="border-b border-line-soft text-fg-2 last:border-b-0">
                        <td class="py-3 pr-3 font-mono">{i + 1}</td>
                        <td class="py-3 pr-3 font-mono whitespace-nowrap">
                          {formatDateSeconds(r.at)}
                        </td>
                        <td class="py-3 font-mono">{r.country === 'XX' ? 'Unknown' : r.country}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {s.retrievalCount > s.retrievals.length && (
                  <Hint class="mt-3">
                    Showing the first {s.retrievals.length} of {s.retrievalCount} retrievals.
                  </Hint>
                )}
              </div>
            )}
          </Panel>
        </div>
        <div class="flex flex-col gap-4">
          {ended ? (
            <Panel>
              <PanelTitle>Not what you expected?</PanelTitle>
              <p class="mb-5 text-sm text-fg-3">
                If the time or country does not match the recipient, assume the link leaked. Rotate
                the key you shared and create a new secret.
              </p>
              <Button variant="primary" block onClick={onNew}>
                Create a new secret
              </Button>
            </Panel>
          ) : (
            <Panel>
              <PanelTitle>Delete</PanelTitle>
              <p class="mb-5 text-sm text-fg-3">
                Removes the encrypted content from our servers now. The share link stops working
                immediately. This page keeps the history for 30 days.
              </p>
              {confirming ? (
                <div
                  ref={deleteGroup}
                  class="flex flex-col gap-2"
                  role="group"
                  aria-label="Confirm deletion"
                >
                  <Notice tone="error" role="alert" icon={<AlertTriangle />}>
                    This cannot be undone.
                  </Notice>
                  <Button
                    variant="danger"
                    block
                    onClick={() => void doDelete()}
                    disabled={deleting}
                  >
                    {deleting ? <Spinner /> : <Trash2 aria-hidden="true" />}
                    Delete permanently
                  </Button>
                  <Button
                    data-safe
                    variant="ghost"
                    block
                    onClick={() => setConfirming(false)}
                    disabled={deleting}
                  >
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button variant="danger" block onClick={() => setConfirming(true)}>
                  <Trash2 aria-hidden="true" />
                  Delete now
                </Button>
              )}
            </Panel>
          )}
          <Panel>
            <PanelTitle>Share link</PanelTitle>
            <p class="text-sm text-fg-3">
              The share link is not stored here. If you lost it, delete this secret and create a new
              one.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
