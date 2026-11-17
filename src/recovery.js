// Keep one authorised context; replace the tab and its page-local application state.
export async function freshMessengerTab(context, previous) {
  // Allocate an empty tab first so Chromium stays alive when its last old tab closes.
  // The caller navigates to Messenger only after previous has closed.
  const next = await context.newPage();
  try {
    if (!previous.isClosed()) await previous.close();
    return next;
  } catch (error) {
    await next.close().catch(() => {});
    throw error;
  }
}

export function retryDelay(error, failures, intervalMs) {
  if (error.status === 403) return 10000;
  return Math.min(300000, intervalMs * 2 ** Math.min(failures, 4));
}
