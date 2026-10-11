import { s3Store } from '../../api/src/files.ts';
import { documentClients } from '../../api/src/repo.ts';
import { logEvent } from './log.ts';
import { sweep, tableItemCount } from './sweep.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

/** Every 5 minutes: the table item count for the alarm, then cleanup per PLAN 9.6. Counts only in the logs. */
export async function handler(): Promise<void> {
  const db = documentClients();
  const table = env('TABLE_NAME');
  // Item count first: a sweep that runs long or fails must not silence the TableItemCount alarm.
  logEvent({ event: 'tableItemCount', value: await tableItemCount(db, table) });
  const counts = await sweep(
    db,
    table,
    s3Store(env('FILES_BUCKET'), process.env.AWS_REGION),
    Math.floor(Date.now() / 1000),
  );
  logEvent({ event: 'sweep', ...counts });
}
