import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUnreadCount } from './api';
import { NotificationBell } from './NotificationBell';
import { NotificationProvider } from './NotificationProvider';
import type { NotificationScope } from './types';

vi.mock('./api');

const mockedGetUnreadCount = vi.mocked(getUnreadCount);

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderBell(scope: NotificationScope, count: number) {
  mockedGetUnreadCount.mockResolvedValue(count);
  return render(
    <MemoryRouter initialEntries={['/somewhere']}>
      <NotificationProvider scope={scope}>
        <NotificationBell />
      </NotificationProvider>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockedGetUnreadCount.mockReset();
});

describe('NotificationBell — badge', () => {
  it('shows no badge at 0, and is still a bell', async () => {
    renderBell({ kind: 'customer' }, 0);
    await settle();

    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it.each([[1, '1'], [7, '7'], [99, '99']])('shows the exact count %j', async (count, text) => {
    renderBell({ kind: 'customer' }, count);
    await settle();

    expect(screen.getByTestId('notification-badge')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: `Notifications, ${count} unread` })).toBeInTheDocument();
  });

  it.each([[100], [250]])('shows "99+" at %j', async (count) => {
    renderBell({ kind: 'customer' }, count);
    await settle();

    expect(screen.getByTestId('notification-badge')).toHaveTextContent('99+');
    expect(screen.getByRole('button', { name: 'Notifications, more than 99 unread' })).toBeInTheDocument();
  });

  it('shows no badge before the first answer', () => {
    mockedGetUnreadCount.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <NotificationProvider scope={{ kind: 'customer' }}>
          <NotificationBell />
        </NotificationProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('keeps the badge out of the accessibility tree — the button\'s own name carries the count', async () => {
    renderBell({ kind: 'customer' }, 5);
    await settle();

    expect(screen.getByTestId('notification-badge')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('NotificationBell — navigation', () => {
  it('goes to /app/notifications in the customer shell', async () => {
    renderBell({ kind: 'customer' }, 2);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/app/notifications');
  });

  it('goes to /org/notifications in the organization shell', async () => {
    renderBell({ kind: 'organization', organizationId: 'org-1' }, 2);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/org/notifications');
  });
});

describe('NotificationBell — without a provider', () => {
  it('renders nothing, and needs no router', () => {
    const { container } = render(<NotificationBell />);

    expect(container).toBeEmptyDOMElement();
  });
});
