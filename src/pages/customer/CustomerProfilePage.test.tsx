import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContextValue } from '../../features/auth/types';
import { useAuth } from '../../features/auth/useAuth';
import { CustomerProfilePage } from './CustomerProfilePage';

vi.mock('../../features/auth/useAuth');

const mockedUseAuth = vi.mocked(useAuth);

describe('CustomerProfilePage', () => {
  it('shows the signed-in user and signs out via useAuth()', () => {
    const signOut = vi.fn(async () => {});
    const value: AuthContextValue = {
      user: { userId: 'U-123', phone: '+911234567890' },
      status: 'signedIn',
      isAuthenticated: true,
      signOut,
    };
    mockedUseAuth.mockReturnValue(value);

    render(<CustomerProfilePage />);

    expect(screen.getByText('+911234567890')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
