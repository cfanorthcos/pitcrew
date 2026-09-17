// Notices when a new version has been deployed, and reloads the kiosk.
//
// The problem this solves is not really caching. It is that nobody ever reloads
// a wall-mounted screen. A browser tab on a desk gets refreshed constantly; an
// iPad bracketed to a wall in the back of house is launched once and then runs
// for weeks. Deploy a fix on Tuesday and the kiosk happily keeps running
// Monday's code until somebody thinks to swipe it closed.
//
// Caching makes that worse rather than causing it. GitHub Pages serves with a
// real max-age, so a reload picks up new files once that window has passed —
// but no reload ever happens, so the window never matters.
//
// No build step, and no version file for a human to remember to bump: the
// server already stamps every response with an ETag (or Last-Modified), so the
// document's own validator IS the version. Poll it, and when it changes from
// what this page booted with, reload — but only at a moment where reloading
// cannot lose anybody's work.

// A HEAD request is enough: only the validator headers are wanted, never the
// body. `no-store` keeps the check itself from being answered out of the cache
// it exists to detect changes in.
export async function readVersionTag(url, fetchImpl) {
  const response = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
  if (!response.ok) return null;
  return response.headers.get('etag') || response.headers.get('last-modified') || null;
}

// Returns a watcher with one method, `check()`, rather than owning a timer.
// The caller schedules it, which is what makes this testable without waiting
// for wall-clock time or stubbing setInterval.
//
// `isSafeToReload` is the important parameter. A reload in the middle of a
// checkout throws away a half-entered name; a reload during a return throws
// away ticked checklist items. The kiosk only allows one when it is sitting
// idle on the board with nothing open, which is where it spends most of its
// life anyway.
export function createVersionWatcher({ url = 'index.html', fetchImpl, reload, isSafeToReload }) {
  let booted = null;
  let pending = false;

  async function check() {
    let tag;
    try {
      tag = await readVersionTag(url, fetchImpl);
    } catch {
      // Offline, or the server is having a moment. Neither is a reason to do
      // anything — the kiosk keeps running the code it already has.
      return 'unreachable';
    }
    if (!tag) return 'no-tag';

    if (booted === null) {
      booted = tag;
      return 'first-seen';
    }
    if (tag === booted) return pending ? 'deferred' : 'unchanged';

    // A new version exists. Remember that even if this is a bad moment, so a
    // later idle check reloads without having to re-notice.
    pending = true;
    if (!isSafeToReload()) return 'deferred';

    reload();
    return 'reloaded';
  }

  return { check };
}
