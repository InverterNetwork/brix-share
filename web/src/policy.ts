import {
  AVAILABILITY_GAP_SEC,
  DAY,
  HOUR,
  MAX_LIFETIME_SEC,
  MAX_VIEWS,
  MIN_LIFETIME_SEC,
  MINUTE,
  secToIso,
  type PolicyInput,
} from '@brix-share/shared';

export type ExpiryPreset = '1h' | '1d' | '7d' | '14d' | '30d' | 'custom';
export type ViewsChoice = 1 | 3 | 10 | 'custom' | 'unlimited';

export const EXPIRY_PRESETS: { value: ExpiryPreset; label: string; sec: number }[] = [
  { value: '1h', label: '1 hour', sec: HOUR },
  { value: '1d', label: '1 day', sec: DAY },
  { value: '7d', label: '7 days', sec: 7 * DAY },
  { value: '14d', label: '14 days', sec: 14 * DAY },
  { value: '30d', label: '30 days', sec: MAX_LIFETIME_SEC },
  { value: 'custom', label: 'Custom', sec: 0 },
];

/** Slack between the clock we computed with and the one the server checks against (PoW time, skew). */
export const CLOCK_MARGIN_SEC = MINUTE;
export const CUSTOM_MIN_SEC = MIN_LIFETIME_SEC + CLOCK_MARGIN_SEC;
export const CUSTOM_MAX_SEC = MAX_LIFETIME_SEC - CLOCK_MARGIN_SEC;

export interface PolicyForm {
  expiry: ExpiryPreset;
  /** Epoch seconds, used when expiry is custom. */
  customExpiry: number | null;
  views: ViewsChoice;
  customViews: number;
  releaseLater: boolean;
  /** Epoch seconds, used when releaseLater is on. */
  availableFrom: number | null;
}

export const DEFAULT_FORM: PolicyForm = {
  expiry: '7d',
  customExpiry: null,
  views: 1,
  customViews: 5,
  releaseLater: false,
  availableFrom: null,
};

export function maxViewsOf(form: PolicyForm): number | null {
  if (form.views === 'unlimited') return null;
  if (form.views === 'custom') return form.customViews;
  return form.views;
}

/** Expiry in epoch seconds for a given server clock. Presets are relative; 30 days keeps a margin. */
export function expiryOf(form: PolicyForm, now: number): number | null {
  if (form.expiry === 'custom') return form.customExpiry;
  const preset = EXPIRY_PRESETS.find((p) => p.value === form.expiry)!;
  return now + Math.min(preset.sec, CUSTOM_MAX_SEC);
}

/** Checks the form against the server clock before any work starts. Returns a message or null. */
export function checkPolicy(form: PolicyForm, now: number): string | null {
  const maxViews = maxViewsOf(form);
  if (maxViews !== null && (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > MAX_VIEWS)) {
    return `Choose between 1 and ${MAX_VIEWS} views.`;
  }
  const exp = expiryOf(form, now);
  if (exp === null) return 'Pick an expiry date.';
  if (exp < now + CUSTOM_MIN_SEC) return 'The expiry must be at least 6 minutes from now.';
  if (exp > now + CUSTOM_MAX_SEC) return 'The expiry can be at most 30 days from now.';
  if (form.releaseLater) {
    if (form.availableFrom === null) return 'Pick a release date or switch release later off.';
    if (form.availableFrom < now + CLOCK_MARGIN_SEC)
      return 'The release date must be in the future.';
    if (form.availableFrom >= exp - AVAILABILITY_GAP_SEC - CLOCK_MARGIN_SEC) {
      return 'The release date must be at least 6 minutes before the expiry.';
    }
  }
  return null;
}

/** Policy for the create request, computed with the server clock at the moment the request is built. */
export function policyOf(form: PolicyForm, now: number): PolicyInput {
  const exp = expiryOf(form, now)!;
  return {
    maxViews: maxViewsOf(form),
    expiresAt: secToIso(exp),
    availableFrom:
      form.releaseLater && form.availableFrom !== null
        ? secToIso(Math.max(form.availableFrom, now))
        : null,
  };
}
