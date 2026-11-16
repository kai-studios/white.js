import { duration } from '../utils/duration.js';

// Circuit breaker: after `threshold` failures in a row the circuit opens and calls fail at
// once for `cooldown`, so a dead service is not hammered and callers do not wait on timeouts.
// After the cooldown one probe call is let through ("half-open"): success closes the
// circuit, failure opens it again.
export function createBreaker({ threshold = 5, cooldown = '30s', now = Date.now } = {}) {
  const wait = duration(cooldown);
  let state = 'closed';
  let failures = 0;
  let openedAt = 0;
  let probing = false;

  const refresh = () => {
    if (state === 'open' && now() - openedAt >= wait) {
      state = 'half-open';
      probing = false;
    }
  };
  const trip = () => {
    state = 'open';
    openedAt = now();
    probing = false;
  };

  return {
    get state() {
      refresh();
      return state;
    },
    get failures() {
      return failures;
    },
    // May a call go out now?
    allow() {
      refresh();
      if (state === 'closed') return true;
      if (state === 'half-open' && !probing) return (probing = true);
      return false;
    },
    success() {
      if (state === 'open') return; // a late answer from before the circuit opened
      failures = 0;
      probing = false;
      state = 'closed';
    },
    failure() {
      if (state === 'open') return;
      failures += 1;
      if (state === 'half-open' || failures >= threshold) trip();
      else probing = false;
    },
    // The call was cancelled by the caller: says nothing about the service
    cancel() {
      probing = false;
    },
    reset() {
      state = 'closed';
      failures = 0;
      probing = false;
    },
  };
}
