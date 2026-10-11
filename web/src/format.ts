const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
const dateTimeSecFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** "16 Oct 2026, 14:32 CEST" */
export function formatDate(input: string | number | Date): string {
  return dateFmt.format(typeof input === 'number' ? new Date(input * 1000) : new Date(input));
}

export function formatDateSeconds(input: string | Date): string {
  return dateTimeSecFmt.format(new Date(input));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function viewsLabel(maxViews: number | null): string {
  if (maxViews === null) return 'Unlimited until expiry';
  if (maxViews === 1) return '1 time';
  return `${maxViews} times`;
}

/** Value for <input type="datetime-local"> in local time, minute precision. */
export function toLocalInput(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Epoch seconds from a datetime-local value (local time), or null if empty or invalid. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
