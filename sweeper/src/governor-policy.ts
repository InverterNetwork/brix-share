import { DEFAULT_POW_DIFFICULTY, MAX_POW_DIFFICULTY, MINUTE } from '@brix-share/shared';

export type AlarmState = 'ALARM' | 'OK';

export interface GovernorState {
  alarm: AlarmState;
  /** When the alarm entered its current state (epoch seconds). */
  since: number;
  /** Last time the governor changed difficulty or createEnabled (epoch seconds). */
  lastChange: number;
}

export interface GovernorInput {
  now: number;
  state: GovernorState;
  difficulty: number;
  createEnabled: boolean;
  /** New alarm state when invoked by an alarm state change, undefined on the schedule. */
  alarmEvent?: AlarmState;
}

export interface GovernorOutput {
  state: GovernorState;
  difficulty: number;
  createEnabled: boolean;
  actions: string[];
}

export const RAISE_STEP = 2;
export const RAISE_INTERVAL_SEC = 15 * MINUTE;
export const CALM_SEC = 60 * MINUTE;
export const SUSTAINED_SEC = 60 * MINUTE;
/** The 15-minute schedule can fire a few seconds early; without slack a step would slip a whole tick. */
export const JITTER_SEC = MINUTE;

export const initialState = (now: number): GovernorState => ({
  alarm: 'OK',
  since: now,
  lastChange: 0,
});

/**
 * Adaptive proof-of-work (PLAN section 12). Under a create-rate alarm, difficulty rises by 2 bits at most
 * every 15 minutes up to 24; after 60 minutes in alarm at the maximum (24), creation is switched off (a human
 * switches it back on). After 60 calm minutes difficulty steps down by 2 bits per hour to the default.
 */
export function decide(input: GovernorInput): GovernorOutput {
  const { now } = input;
  const state = { ...input.state };
  let { difficulty, createEnabled } = input;
  const actions: string[] = [];

  if (input.alarmEvent && input.alarmEvent !== state.alarm) {
    state.alarm = input.alarmEvent;
    state.since = now;
    actions.push(`alarm:${input.alarmEvent}`);
  }

  if (state.alarm === 'ALARM') {
    if (
      difficulty < MAX_POW_DIFFICULTY &&
      now - state.lastChange >= RAISE_INTERVAL_SEC - JITTER_SEC
    ) {
      difficulty = Math.min(MAX_POW_DIFFICULTY, difficulty + RAISE_STEP);
      state.lastChange = now;
      actions.push(`raise:${difficulty}`);
    } else if (
      difficulty >= MAX_POW_DIFFICULTY &&
      createEnabled &&
      now - Math.max(state.since, state.lastChange) >= SUSTAINED_SEC - JITTER_SEC
    ) {
      createEnabled = false;
      state.lastChange = now;
      actions.push('create-disabled');
    }
  } else if (
    difficulty > DEFAULT_POW_DIFFICULTY &&
    now - state.since >= CALM_SEC - JITTER_SEC &&
    now - state.lastChange >= CALM_SEC - JITTER_SEC
  ) {
    difficulty = Math.max(DEFAULT_POW_DIFFICULTY, difficulty - RAISE_STEP);
    state.lastChange = now;
    actions.push(`lower:${difficulty}`);
  }

  return { state, difficulty, createEnabled, actions };
}

export function parseState(raw: string | undefined, now: number): GovernorState {
  if (!raw) return initialState(now);
  try {
    const v = JSON.parse(raw) as Partial<GovernorState>;
    if (
      (v.alarm === 'ALARM' || v.alarm === 'OK') &&
      typeof v.since === 'number' &&
      typeof v.lastChange === 'number'
    ) {
      return { alarm: v.alarm, since: v.since, lastChange: v.lastChange };
    }
  } catch {
    // fall through to a fresh state
  }
  return initialState(now);
}
