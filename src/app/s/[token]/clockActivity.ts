'use client';

// Shared client signal: how many ClockControls are currently mounted on the /s/[token] page. The
// page's low-frequency self-heal (ScheduleAutoRefresh) reads this and only refreshes when it is
// zero. A ClockControls is mounted for the whole in-window period, and the QR sheet AND the in-flight
// punch both live INSIDE a mounted control — so "zero mounted" also guarantees no sheet is open and
// no punch is in flight, which is exactly the guard the refresh needs. Module-level singleton: only
// ever one schedule page is mounted at a time, so no context provider is needed.
let mounted = 0;

// Acquire on ClockControls mount; call the returned release on unmount. Idempotent, so React 18
// StrictMode's mount→unmount→remount in dev (and any double release) can't drive the count negative.
export function acquireClockActivity(): () => void {
  mounted += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mounted -= 1;
  };
}

export function clockControlsMounted(): boolean {
  return mounted > 0;
}
