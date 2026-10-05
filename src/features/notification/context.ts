import { createContext, useContext } from 'react';
import type { NotificationScope } from './types';

/** Why the unread-count poll stopped for good, if it did. */
export type NotificationPollStop = 'unauthorized' | 'forbidden';

export interface NotificationContextValue {
  /** Which inbox this shell's provider serves (see `NotificationScope`). */
  scope: NotificationScope;
  /**
   * The last unread count the backend gave, or `null` before the first answer
   * (and once polling has stopped for good). A transient failure leaves it as it
   * was. Never computed on the client.
   */
  unreadCount: number | null;
  /** Set once a 401/403 has stopped polling; it is not retried. */
  stopped: NotificationPollStop | null;
  /**
   * Asks for the unread count now (e.g. after something was marked read). A
   * no-op once polling has stopped for good; a request made while one is in
   * flight is answered by one more read right after it, never lost.
   */
  refreshUnreadCount: () => void;
}

export const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

/**
 * The shell's notification state, or `undefined` outside a provider — so a
 * page that shows the bell (every organization page, three customer tabs) still
 * renders on its own, in a test or in a shell without one, with no bell.
 */
export function useOptionalNotifications(): NotificationContextValue | undefined {
  return useContext(NotificationContext);
}
