import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnsureProfileLoaded } from './EnsureProfileLoaded';

const getMeMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ getMe: getMeMock }));

const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../auth/useAuth', () => ({ useAuth: useAuthMock }));

function mockStatus(status: 'initializing' | 'signedIn' | 'signedOut') {
  useAuthMock.mockReturnValue({
    status,
    user: null,
    isAuthenticated: status === 'signedIn',
    signOut: vi.fn(),
  });
}

describe('EnsureProfileLoaded', () => {
  beforeEach(() => {
    getMeMock.mockReset();
    getMeMock.mockResolvedValue({ id: 'U-1', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('does not call getMe while initializing or signed out', () => {
    mockStatus('initializing');
    const { rerender } = render(<EnsureProfileLoaded />);
    expect(getMeMock).not.toHaveBeenCalled();

    mockStatus('signedOut');
    rerender(<EnsureProfileLoaded />);
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it('calls getMe exactly once when the session becomes signed in, even across re-renders', () => {
    mockStatus('signedIn');
    const { rerender } = render(<EnsureProfileLoaded />);
    rerender(<EnsureProfileLoaded />);
    rerender(<EnsureProfileLoaded />);

    expect(getMeMock).toHaveBeenCalledTimes(1);
  });

  it('calls getMe again for a new session after signing out and back in', () => {
    mockStatus('signedIn');
    const { rerender } = render(<EnsureProfileLoaded />);
    expect(getMeMock).toHaveBeenCalledTimes(1);

    mockStatus('signedOut');
    rerender(<EnsureProfileLoaded />);

    mockStatus('signedIn');
    rerender(<EnsureProfileLoaded />);

    expect(getMeMock).toHaveBeenCalledTimes(2);
  });

  it('does not throw or retry when GET /api/me fails', async () => {
    getMeMock.mockReset();
    getMeMock.mockRejectedValue(new Error('Backend unavailable.'));
    mockStatus('signedIn');

    expect(() => render(<EnsureProfileLoaded />)).not.toThrow();
    await waitFor(() => expect(getMeMock).toHaveBeenCalledTimes(1));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMeMock).toHaveBeenCalledTimes(1);
  });
});
