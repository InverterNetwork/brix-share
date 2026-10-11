import { useEffect, useState } from 'preact/hooks';
import { serverNow } from '../api.ts';

/** Days, hours, minutes (and seconds in the last hour) until `targetSec`, by the server clock. */
export function Countdown({ targetSec, onDone }: { targetSec: number; onDone?: () => void }) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const t = window.setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, targetSec - now);
  useEffect(() => {
    if (left === 0) onDone?.();
  }, [left === 0]);
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const min = Math.floor((left % 3600) / 60);
  const sec = left % 60;
  const parts: [string, number][] =
    days > 0
      ? [
          ['days', days],
          ['hours', hours],
          ['min', min],
        ]
      : [
          ['hours', hours],
          ['min', min],
          ['sec', sec],
        ];
  return (
    <div
      class="my-5 flex gap-5"
      role="timer"
      aria-label={`${days} days ${hours} hours ${min} minutes left`}
    >
      {parts.map(([label, v]) => (
        <div key={label} class="text-center">
          <b class="block font-mono text-[32px] leading-none font-medium text-white">
            {String(v).padStart(2, '0')}
          </b>
          <span class="font-mono text-[11px] tracking-[0.08em] text-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}
