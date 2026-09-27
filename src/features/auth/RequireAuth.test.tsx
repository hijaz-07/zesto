import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { descopeMock } from '../../test/mockDescopeSdk';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './RequireAuth';

vi.mock('@descope/react-sdk', async () => (await import('../../test/mockDescopeSdk')).mockDescopeSdkModule);

function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname;
  return <div>Login page (from: {from ?? 'none'})</div>;
}

function renderWithGuard(initialEntries: string[]) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route
            path="/app"
            element={
              <RequireAuth>
                <div>Protected content</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('RequireAuth (Descope session)', () => {
  beforeEach(() => {
    descopeMock.reset();
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows a loading state while the Descope session is loading, without revealing protected content', () => {
    descopeMock.setSessionLoading();

    renderWithGuard(['/app']);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders protected content when the Descope session is authenticated', () => {
    descopeMock.setSignedIn();

    renderWithGuard(['/app']);

    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('redirects to the login page, remembering the requested route, when there is no Descope session', () => {
    renderWithGuard(['/app']);

    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(screen.getByText('Login page (from: /app)')).toBeInTheDocument();
  });
});
