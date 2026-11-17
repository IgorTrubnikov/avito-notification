import { MESSENGER, openMessenger } from './avito.js';

export async function recoverMessengerTab(page, options = {}) {
  const current = new URL(page.url());
  const target = new URL(MESSENGER);
  if (current.origin === target.origin && current.pathname === target.pathname && current.hash === '#block') {
    options.log?.('Clearing #block in the current tab');
    // Trigger the site's real hashchange navigation; replaceState would only
    // change the address bar and would not notify its router.
    await page.evaluate(() => { location.hash = ''; });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      if (location.hash === '' && location.href.endsWith('#')) {
        history.replaceState(history.state, '', location.href.slice(0, -1));
      }
    });
  } else {
    options.log?.('Reopening messenger in the current tab');
    await openMessenger(page, options);
  }
}

export function retryDelay(error, failures, intervalMs) {
  if (error.status === 403) return 10000;
  return Math.min(300000, intervalMs * 2 ** Math.min(failures, 4));
}
