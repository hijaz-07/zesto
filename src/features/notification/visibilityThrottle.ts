/**
 * The shortest time between two notification reads that a page becoming
 * visible may cause. The unread-count poller (`NotificationProvider`) and the
 * notification list (`useNotifications`) both refresh when the page returns to
 * the foreground, and both use this one number, so they stay consistent.
 *
 * It exists because some environments (an embedded browser pane, a webview that
 * flickers while it is being shown or hidden) fire `visibilitychange` back to
 * back, and every "visible" would otherwise send a request. A visibility return
 * inside this window of the last read is skipped: the data on screen is at most
 * this old, which is nothing next to the 30 s poll beat.
 *
 * It limits ONLY visibility-triggered reads. The ordinary poll beat, an explicit
 * refresh (after marking something read, Retry, mount) and "load more" are never
 * delayed by it.
 */
export const VISIBILITY_REFRESH_MIN_INTERVAL_MS = 10_000;

/**
 * Leading-edge throttle: the first visibility return goes through at once, any
 * further one inside the window does not.
 *
 * @param lastReadAt When the last read of this kind started (ms, `Date.now()`
 *   scale); `-Infinity` if there has been none.
 * @param now The current time, same scale.
 * @return Whether a page becoming visible may read now.
 */
export function visibilityRefreshAllowed(lastReadAt: number, now: number): boolean {
  return now - lastReadAt >= VISIBILITY_REFRESH_MIN_INTERVAL_MS;
}
