// Pure classification of youtube-chat ChatItems on RECONNECT — separates the
// initial history burst YT hands back on a fresh continuation (recovered)
// from genuinely live items, with id dedupe and age/count caps. No network,
// no timers — kept separate from poller.mjs so it's unit-testable, same
// split as normalize.mjs.
//
// The library gives no batch-boundary signal, only per-item 'chat' events,
// so each item self-classifies by its own YT timestamp against T = wall
// clock when the reconnect's session was established (armedAt): older than
// T is recovered, T or newer is live — and arming disarms on the first live
// item. Clock skew at that exact boundary only misclassifies dim-vs-normal
// styling; cosmetic, acceptable.

export const RECOVERY_AGE_CAP_MS = 10 * 60_000;
export const RECOVERY_COUNT_CAP = 200;
export const ID_CACHE_SIZE = 200;

function addToBoundedSet(set, value, maxSize) {
  set.add(value);
  if (set.size > maxSize) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

// ephemeral = { armed, armedAt, recoveredCount } — per-run(), reset on every
// (re)connect. seenIds is a Set the caller owns across the whole process
// lifetime (module-level), so dedupe survives multiple reconnects.
export function classifyYtItem(item, ephemeral, seenIds) {
  const id = item.id;
  if (id && seenIds.has(id)) {
    return { send: false, recovered: false, ephemeral };
  }

  if (!ephemeral.armed) {
    if (id) addToBoundedSet(seenIds, id, ID_CACHE_SIZE);
    return { send: true, recovered: false, ephemeral };
  }

  const tsMs = item.timestamp instanceof Date ? item.timestamp.getTime() : Date.now();
  if (tsMs >= ephemeral.armedAt) {
    if (id) addToBoundedSet(seenIds, id, ID_CACHE_SIZE);
    return { send: true, recovered: false, ephemeral: { ...ephemeral, armed: false } };
  }

  const tooOld = ephemeral.armedAt - tsMs > RECOVERY_AGE_CAP_MS;
  const overCap = ephemeral.recoveredCount >= RECOVERY_COUNT_CAP;
  if (tooOld || overCap) {
    return { send: false, recovered: false, ephemeral };
  }

  if (id) addToBoundedSet(seenIds, id, ID_CACHE_SIZE);
  return {
    send: true,
    recovered: true,
    ephemeral: { ...ephemeral, recoveredCount: ephemeral.recoveredCount + 1 },
  };
}
