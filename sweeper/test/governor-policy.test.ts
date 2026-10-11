import { describe, expect, it } from 'vitest';
import { decide, initialState, parseState, type GovernorInput } from '../src/governor-policy.ts';

const T0 = 1_800_000_000;
const MIN = 60;

function run(
  steps: { at: number; alarmEvent?: 'ALARM' | 'OK' }[],
  start: Partial<GovernorInput> = {},
) {
  let cur = {
    state: initialState(T0 - 10 * 60 * MIN),
    difficulty: 18,
    createEnabled: true,
    ...start,
  };
  const log: string[][] = [];
  for (const s of steps) {
    const out = decide({ ...cur, now: T0 + s.at, alarmEvent: s.alarmEvent });
    log.push(out.actions);
    cur = { state: out.state, difficulty: out.difficulty, createEnabled: out.createEnabled };
  }
  return { ...cur, log };
}

describe('governor policy', () => {
  it('does nothing while calm at the default', () => {
    const r = run([{ at: 0 }, { at: 15 * MIN }, { at: 120 * MIN }]);
    expect(r.difficulty).toBe(18);
    expect(r.createEnabled).toBe(true);
    expect(r.log.flat()).toEqual([]);
  });

  it('raises by 2 immediately on alarm, then at most every 15 minutes, capped at 24', () => {
    const r = run([
      { at: 0, alarmEvent: 'ALARM' },
      { at: 5 * MIN },
      { at: 15 * MIN },
      { at: 30 * MIN },
      { at: 45 * MIN },
    ]);
    expect(r.log).toEqual([['alarm:ALARM', 'raise:20'], [], ['raise:22'], ['raise:24'], []]);
    expect(r.difficulty).toBe(24);
    expect(r.createEnabled).toBe(true);
  });

  it('disables creation after 60 minutes in alarm at the maximum, and never re-enables it', () => {
    const r = run([
      { at: 0, alarmEvent: 'ALARM' },
      { at: 15 * MIN },
      { at: 30 * MIN }, // reaches 24
      { at: 60 * MIN },
      { at: 88 * MIN },
      { at: 90 * MIN - 30 }, // schedule fired slightly early: still counts
      { at: 91 * MIN, alarmEvent: 'OK' },
      { at: 300 * MIN },
    ]);
    expect(r.log.slice(0, 5)).toEqual([
      ['alarm:ALARM', 'raise:20'],
      ['raise:22'],
      ['raise:24'],
      [],
      [],
    ]);
    expect(r.log[5]).toEqual(['create-disabled']);
    expect(r.createEnabled).toBe(false);
  });

  it('tolerates a schedule tick that fires a few seconds early', () => {
    const r = run([{ at: 0, alarmEvent: 'ALARM' }, { at: 15 * MIN - 5 }]);
    expect(r.log).toEqual([['alarm:ALARM', 'raise:20'], ['raise:22']]);
  });

  it('a human-set maximum still waits 60 minutes in alarm before disabling', () => {
    const r = run([{ at: 0, alarmEvent: 'ALARM' }, { at: 30 * MIN }, { at: 60 * MIN }], {
      difficulty: 24,
    });
    expect(r.log).toEqual([['alarm:ALARM'], [], ['create-disabled']]);
  });

  it('steps down by 2 per calm hour to the default', () => {
    const r = run(
      [
        { at: 0, alarmEvent: 'OK' },
        { at: 30 * MIN },
        { at: 60 * MIN },
        { at: 90 * MIN },
        { at: 120 * MIN },
        { at: 600 * MIN },
      ],
      {
        difficulty: 22,
        state: { alarm: 'ALARM', since: T0 - 60 * MIN, lastChange: T0 - 30 * MIN },
      },
    );
    expect(r.log).toEqual([['alarm:OK'], [], ['lower:20'], [], ['lower:18'], []]);
    expect(r.difficulty).toBe(18);
  });

  it('does not lower a human-set difficulty below the default and ignores repeated identical events', () => {
    const r = run([{ at: 0, alarmEvent: 'OK' }, { at: 200 * MIN }], { difficulty: 16 });
    expect(r.difficulty).toBe(16);
    expect(r.log.flat()).toEqual([]);
  });

  it('parses stored state defensively', () => {
    expect(parseState(undefined, T0)).toEqual(initialState(T0));
    expect(parseState('nope', T0)).toEqual(initialState(T0));
    expect(parseState('{"alarm":"ALARM","since":1,"lastChange":2}', T0)).toEqual({
      alarm: 'ALARM',
      since: 1,
      lastChange: 2,
    });
    expect(parseState('{"alarm":"WAT","since":1,"lastChange":2}', T0)).toEqual(initialState(T0));
  });
});
