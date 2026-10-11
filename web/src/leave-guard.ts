/**
 * Protects state that cannot be recovered (a retrieved one-time secret) from in-app navigation, back/forward
 * and tab close. Screens set a message while such state exists and clear it afterwards.
 */
let message: string | null = null;

function onBeforeUnload(e: BeforeUnloadEvent) {
  // Current engines show their own generic prompt when the event is cancelled.
  e.preventDefault();
}

export function setLeaveGuard(next: string | null): void {
  if (next !== null && message === null) addEventListener('beforeunload', onBeforeUnload);
  if (next === null && message !== null) removeEventListener('beforeunload', onBeforeUnload);
  message = next;
}

/** True when leaving is fine (no guard, or the user confirmed). */
export function confirmLeave(): boolean {
  if (message === null) return true;
  if (!window.confirm(message)) return false;
  setLeaveGuard(null);
  return true;
}
