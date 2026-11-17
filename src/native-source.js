export function freshNative(state, maxAgeMs, after = -1) {
  return state.kind === 'count' && state.revision > after && Date.now() - state.at < maxAgeMs;
}

export async function readNativeCount(observer, { maxAgeMs, after = -1, waitMs = 10000, signal }) {
  let state = observer.snapshot();
  if (!freshNative(state, maxAgeMs, after) && !(state.kind === 'error' && state.revision > after)) {
    await observer.waitForUpdate(waitMs, Math.max(after, state.revision), { signal });
    state = observer.snapshot();
  }
  if (freshNative(state, maxAgeMs, after)) return state;
  const error = new Error(`Avito: native unread ${state.kind === 'error' ? state.message : 'count is missing or stale'}`);
  error.status = state.kind === 'error' ? state.status : undefined;
  throw error;
}
