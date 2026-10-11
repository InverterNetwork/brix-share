import { GetParametersCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DEFAULT_POW_DIFFICULTY, MAX_POW_DIFFICULTY, MIN_POW_DIFFICULTY } from '@brix-share/shared';
import { decide, parseState, type AlarmState } from './governor-policy.ts';
import { logEvent } from './log.ts';

const ssm = new SSMClient({});

interface GovernorEvent {
  source?: string;
  'detail-type'?: string;
  detail?: { state?: { value?: string } };
}

function alarmFromEvent(event: GovernorEvent): AlarmState | undefined {
  if (event['detail-type'] !== 'CloudWatch Alarm State Change') return undefined;
  return event.detail?.state?.value === 'ALARM' ? 'ALARM' : 'OK';
}

export async function handler(event: GovernorEvent): Promise<void> {
  const prefix = process.env.PARAM_PREFIX;
  if (!prefix) throw new Error('PARAM_PREFIX not set');
  const names = {
    difficulty: `${prefix}/powDifficulty`,
    enabled: `${prefix}/createEnabled`,
    state: `${prefix}/governor`,
  };
  const now = Math.floor(Date.now() / 1000);

  const res = await ssm.send(new GetParametersCommand({ Names: Object.values(names) }));
  const get = (n: string) => res.Parameters?.find((p) => p.Name === n)?.Value;
  const parsedDifficulty = Number(get(names.difficulty));
  const difficulty =
    Number.isInteger(parsedDifficulty) &&
    parsedDifficulty >= MIN_POW_DIFFICULTY &&
    parsedDifficulty <= MAX_POW_DIFFICULTY
      ? parsedDifficulty
      : DEFAULT_POW_DIFFICULTY;
  const createEnabled = get(names.enabled) !== 'false';
  const state = parseState(get(names.state), now);

  const out = decide({ now, state, difficulty, createEnabled, alarmEvent: alarmFromEvent(event) });

  if (out.difficulty !== difficulty) {
    await ssm.send(
      new PutParameterCommand({
        Name: names.difficulty,
        Value: String(out.difficulty),
        Overwrite: true,
      }),
    );
  }
  if (out.createEnabled !== createEnabled) {
    await ssm.send(
      new PutParameterCommand({
        Name: names.enabled,
        Value: String(out.createEnabled),
        Overwrite: true,
      }),
    );
  }
  if (JSON.stringify(out.state) !== JSON.stringify(state)) {
    await ssm.send(
      new PutParameterCommand({
        Name: names.state,
        Value: JSON.stringify(out.state),
        Overwrite: true,
      }),
    );
  }
  logEvent({
    event: 'governor',
    alarm: out.state.alarm,
    difficulty: out.difficulty,
    createEnabled: out.createEnabled,
    actions: out.actions.join(','),
  });
}
