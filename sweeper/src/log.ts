/**
 * One JSON object per line on stdout. With Lambda's TEXT log format the line is the whole log event, so
 * CloudWatch metric filters can match on `$.event`. Never pass bodies, tokens, envelopes or URLs.
 */
export function logEvent(fields: Record<string, string | number | boolean | null>): void {
  process.stdout.write(JSON.stringify(fields) + '\n');
}
