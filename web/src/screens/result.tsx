import { Info } from 'lucide-preact';
import type { CreatedSecret } from '../create-flow.ts';
import { formatDate, viewsLabel } from '../format.ts';
import {
  Button,
  Chip,
  CopyButton,
  Hint,
  KeyValues,
  LinkBox,
  Lede,
  Notice,
  PageTitle,
  Panel,
  PanelTitle,
} from '../ui/kit.tsx';
import { Qr } from '../ui/qr.tsx';

export function ResultScreen({
  secret,
  onAnother,
  onManage,
}: {
  secret: CreatedSecret;
  onAnother: () => void;
  onManage: () => void;
}) {
  const r = secret.response;
  const fragment = secret.shareUrl.slice(secret.shareUrl.indexOf(`/s/`) + 3);
  const manageFragment = secret.manageUrl.slice(secret.manageUrl.indexOf(`/m/`) + 3);
  return (
    <div>
      <PageTitle>Your secret is ready.</PageTitle>
      <Lede>
        Two links. The share link opens the secret. The manage link shows whether it was opened and
        lets you delete it. Keep the manage link to yourself.
      </Lede>
      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div class="flex flex-col gap-4">
          <Panel>
            <PanelTitle hint="send this to the recipient">Share link</PanelTitle>
            <LinkBox label="Share link" value={secret.shareUrl} highlight={fragment} />
            <div class="mt-4 flex flex-wrap gap-2">
              <Chip>
                {r.maxViews === 1
                  ? 'Opens 1 time'
                  : r.maxViews === null
                    ? 'Unlimited until expiry'
                    : `Opens ${r.maxViews} times`}
              </Chip>
              <Chip>Expires {formatDate(r.expiresAt)}</Chip>
              {r.availableFrom && <Chip>Available from {formatDate(r.availableFrom)}</Chip>}
              <Chip tone={secret.passphrase ? 'ok' : 'off'}>
                {secret.passphrase ? 'Passphrase set' : 'No passphrase'}
              </Chip>
            </div>
            <div class="mt-5">
              <Notice icon={<Info />}>
                {secret.passphrase
                  ? 'Send the link and the passphrase through different channels. '
                  : 'Anyone with the link can open the secret. '}
                Chat previews do not consume it: the secret is only retrieved when the recipient
                clicks Reveal.
              </Notice>
            </div>
          </Panel>

          {secret.passphrase && (
            <Panel>
              <PanelTitle hint="pass it on over a second channel, for example a call or Signal, never next to the link">
                Passphrase
              </PanelTitle>
              <div class="flex flex-col gap-2 rounded-sm border border-line bg-field p-2.5 pl-3.5 sm:flex-row sm:items-center">
                <code
                  aria-label="Passphrase"
                  class="min-w-0 flex-1 font-mono text-sm break-all text-white"
                >
                  {secret.passphrase}
                </code>
                <div class="self-end sm:self-auto">
                  <CopyButton text={secret.passphrase} />
                </div>
              </div>
            </Panel>
          )}

          <Panel>
            <PanelTitle hint="for you only">Manage link</PanelTitle>
            <LinkBox label="Manage link" value={secret.manageUrl} highlight={manageFragment} />
            <Hint class="mt-3">
              Shows when the secret was opened and from which country. Lets you delete it at any
              time. Stays available for 30 days after the secret ends.
            </Hint>
          </Panel>
        </div>

        <div class="flex flex-col gap-4">
          <Panel>
            <PanelTitle>Summary</PanelTitle>
            <KeyValues
              rows={[
                ...(secret.title ? ([['Title', secret.title]] as [string, string][]) : []),
                ['Expires', formatDate(r.expiresAt)],
                ['Can be opened', viewsLabel(r.maxViews)],
                ['Release', r.availableFrom ? formatDate(r.availableFrom) : 'Immediately'],
                ['Passphrase', secret.passphrase ? 'Yes' : 'No'],
                ['Files', secret.fileCount === 0 ? 'None' : `${secret.fileCount} attached`],
              ]}
            />
            <div class="mt-6 flex flex-col gap-2">
              <Button variant="primary" block onClick={onManage}>
                Open manage page
              </Button>
              <Button block onClick={onAnother}>
                Create another
              </Button>
            </div>
          </Panel>
          <Panel class="flex flex-col items-center gap-3">
            <Qr value={secret.shareUrl} label="QR code of the share link" />
            <Hint>QR of the share link</Hint>
          </Panel>
        </div>
      </div>
    </div>
  );
}
