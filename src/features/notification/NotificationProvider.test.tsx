import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { getUnreadCount } from './api';
import { useOptionalNotifications } from './context';
import { NOTIFICATION_POLL_MS, NotificationProvider } from './NotificationProvider';
import type { NotificationScope } from './types';

vi.mock('./api');

const mockedGetUnreadCount = vi.mocked(getUnreadCount);

const CUSTOMER: NotificationScope = { kind: 'customer' };
const ORG: NotificationScope = { kind: 'organization', organizationId: 'org-1' };

let visibility: 'visible' | 'hidden' = 'visible';

function setVisibility(state: 'visible' | 'hidden') {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function Probe() {
  const notifications = useOptionalNotifications();
  if (!notifications) {
    return <p>no provider</p>;
  }
  return (
    <div>
      <p data-testid="count">{notifications.unreadCount === null ? 'none' : String(notifications.unreadCount)}</p>
      <p data-testid="stopped">{notifications.stopped ?? 'running'}</p>
      <p data-testid="scope">{notifications.scope.kind}</p>
      <button onClick={notifications.refreshUnreadCount}>refresh now</button>
    </div>
  );
}

function renderProvider(scope: NotificationScope = CUSTOMER) {
  return render(
    <NotificationProvider scope={scope}>
      <Probe />
    </NotificationProvider>,
  );
}

const count = () => screen.getByTestId('count').textContent;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  mockedGetUnreadCount.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error - removes the per-test override so jsdom's own property is back
  delete document.visibilityState;
});

describe('NotificationProvider — the unread count', () => {
  it('loads the count once when it mounts, and shows nothing until then', async () => {
    mockedGetUnreadCount.mockResolvedValue(3);

    renderProvider();
    expect(count()).toBe('none');
    await flush();

    expect(count()).toBe('3');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['customer', CUSTOMER],
    ['organization', ORG],
  ])('reads only the %s inbox\'s count', async (_label, scope) => {
    mockedGetUnreadCount.mockResolvedValue(1);

    renderProvider(scope);
    await advance(NOTIFICATION_POLL_MS);

    expect(mockedGetUnreadCount.mock.calls.length).toBeGreaterThan(1);
    for (const [calledWith] of mockedGetUnreadCount.mock.calls) {
      expect(calledWith).toEqual(scope);
    }
  });

  it('exposes its scope to the bell and the page', async () => {
    mockedGetUnreadCount.mockResolvedValue(0);

    renderProvider(ORG);
    await flush();

    expect(screen.getByTestId('scope')).toHaveTextContent('organization');
  });

  it('is absent (undefined) outside a provider', () => {
    render(<Probe />);

    expect(screen.getByText('no provider')).toBeInTheDocument();
  });
});

describe('NotificationProvider — polling', () => {
  it('polls about every 30 seconds while the page is visible, not before', async () => {
    mockedGetUnreadCount.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(5);

    renderProvider();
    await flush();
    expect(count()).toBe('1');

    await advance(NOTIFICATION_POLL_MS - 1);
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(count()).toBe('2');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(2);

    await advance(NOTIFICATION_POLL_MS);
    expect(count()).toBe('5');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(3);
  });

  it('the beat is 30 seconds', () => {
    expect(NOTIFICATION_POLL_MS).toBe(30_000);
  });

  it('pauses while the page is hidden: nothing is requested, however long it stays hidden', async () => {
    mockedGetUnreadCount.mockResolvedValue(1);
    renderProvider();
    await flush();

    setVisibility('hidden');
    await advance(NOTIFICATION_POLL_MS * 10);

    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);
  });

  it('refreshes at once when the page becomes visible again, then resumes the beat', async () => {
    mockedGetUnreadCount.mockResolvedValueOnce(1).mockResolvedValueOnce(4).mockResolvedValue(6);
    renderProvider();
    await flush();
    setVisibility('hidden');
    await advance(NOTIFICATION_POLL_MS * 3);

    setVisibility('visible');
    await flush();

    expect(count()).toBe('4');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(2);

    await advance(NOTIFICATION_POLL_MS);
    expect(count()).toBe('6');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(3);
  });

  it('a read that finishes while the page is hidden does not schedule the next one', async () => {
    let release: (value: number) => void = () => {};
    mockedGetUnreadCount.mockReturnValueOnce(new Promise<number>((resolve) => (release = resolve)));
    mockedGetUnreadCount.mockResolvedValue(8);
    renderProvider();

    setVisibility('hidden');
    await act(async () => {
      release(2);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count()).toBe('2');
    await advance(NOTIFICATION_POLL_MS * 5);

    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start polling when it mounts while hidden — until the page is shown', async () => {
    visibility = 'hidden';
    mockedGetUnreadCount.mockResolvedValue(2);

    renderProvider();
    await advance(NOTIFICATION_POLL_MS * 2);
    expect(mockedGetUnreadCount).not.toHaveBeenCalled();

    setVisibility('visible');
    await flush();
    expect(count()).toBe('2');
  });

  it('never has two reads in flight: the next is scheduled only after the last finished', async () => {
    let release: (value: number) => void = () => {};
    mockedGetUnreadCount.mockReturnValueOnce(new Promise<number>((resolve) => (release = resolve)));
    mockedGetUnreadCount.mockResolvedValue(9);

    renderProvider();
    await advance(NOTIFICATION_POLL_MS * 3);
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(2);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count()).toBe('2');
    await advance(NOTIFICATION_POLL_MS);
    expect(count()).toBe('9');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(2);
  });

  it('refreshUnreadCount reads now; a request made during a read is answered by one more read right after it', async () => {
    let release: (value: number) => void = () => {};
    mockedGetUnreadCount.mockReturnValueOnce(new Promise<number>((resolve) => (release = resolve)));
    mockedGetUnreadCount.mockResolvedValue(7);
    renderProvider();

    fireEvent.click(screen.getByText('refresh now'));
    fireEvent.click(screen.getByText('refresh now'));
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(1);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(2);
    expect(count()).toBe('7');
  });

  it('stops everything when it unmounts: no more reads, no leaked timer or listener', async () => {
    mockedGetUnreadCount.mockResolvedValue(1);
    const { unmount } = renderProvider();
    await flush();
    const callsBefore = mockedGetUnreadCount.mock.calls.length;

    unmount();
    await advance(NOTIFICATION_POLL_MS * 5);
    setVisibility('hidden');
    setVisibility('visible');
    await flush();

    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(callsBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a read that finishes after it unmounted', async () => {
    let release: (value: number) => void = () => {};
    mockedGetUnreadCount.mockReturnValue(new Promise<number>((resolve) => (release = resolve)));
    const { unmount } = renderProvider();

    unmount();
    await act(async () => {
      release(5);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('NotificationProvider — failures', () => {
  it('a network error keeps the last known count, shows no error, and the beat goes on', async () => {
    mockedGetUnreadCount
      .mockResolvedValueOnce(4)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'))
      .mockResolvedValueOnce(5);
    renderProvider();
    await flush();
    expect(count()).toBe('4');

    await advance(NOTIFICATION_POLL_MS);
    expect(count()).toBe('4');
    await advance(NOTIFICATION_POLL_MS);
    expect(count()).toBe('4');
    expect(screen.getByTestId('stopped')).toHaveTextContent('running');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await advance(NOTIFICATION_POLL_MS);
    expect(count()).toBe('5');
  });

  it('a 401 stops polling for good and drops the count', async () => {
    mockedGetUnreadCount.mockResolvedValueOnce(4).mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'x'));
    renderProvider();
    await flush();

    await advance(NOTIFICATION_POLL_MS);

    expect(screen.getByTestId('stopped')).toHaveTextContent('unauthorized');
    expect(count()).toBe('none');
    await advance(NOTIFICATION_POLL_MS * 5);
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    fireEvent.click(screen.getByText('refresh now'));
    await flush();
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a 403 stops polling for good — an organization member whose access was removed is not retried forever', async () => {
    mockedGetUnreadCount.mockResolvedValueOnce(2).mockRejectedValueOnce(new ApiError(403, 'permission_denied', 'x'));
    renderProvider(ORG);
    await flush();

    await advance(NOTIFICATION_POLL_MS);

    expect(screen.getByTestId('stopped')).toHaveTextContent('forbidden');
    expect(count()).toBe('none');
    await advance(NOTIFICATION_POLL_MS * 10);
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(2);
  });

  it('a 403 on the very first read stops immediately', async () => {
    mockedGetUnreadCount.mockRejectedValue(new ApiError(403, 'permission_denied', 'x'));

    renderProvider(ORG);
    await flush();
    await advance(NOTIFICATION_POLL_MS * 3);

    expect(screen.getByTestId('stopped')).toHaveTextContent('forbidden');
    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationProvider — scope', () => {
  it('starts over, showing nothing of the old inbox, when the organization changes', async () => {
    mockedGetUnreadCount.mockResolvedValueOnce(8).mockResolvedValueOnce(2);
    const view = (organizationId: string) => (
      <NotificationProvider scope={{ kind: 'organization', organizationId }}>
        <Probe />
      </NotificationProvider>
    );
    const { rerender } = render(view('org-a'));
    await flush();
    expect(count()).toBe('8');

    rerender(view('org-b'));
    expect(count()).toBe('none');
    await flush();

    expect(count()).toBe('2');
    expect(mockedGetUnreadCount.mock.calls.map(([scope]) => scope)).toEqual([
      { kind: 'organization', organizationId: 'org-a' },
      { kind: 'organization', organizationId: 'org-b' },
    ]);
  });

  it('does not restart when it is re-rendered with an equal scope', async () => {
    mockedGetUnreadCount.mockResolvedValue(1);
    const { rerender } = render(
      <NotificationProvider scope={{ kind: 'organization', organizationId: 'org-a' }}>
        <Probe />
      </NotificationProvider>,
    );
    await flush();

    rerender(
      <NotificationProvider scope={{ kind: 'organization', organizationId: 'org-a' }}>
        <Probe />
      </NotificationProvider>,
    );
    await flush();

    expect(mockedGetUnreadCount).toHaveBeenCalledTimes(1);
  });
});
