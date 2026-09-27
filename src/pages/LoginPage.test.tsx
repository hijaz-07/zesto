import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../features/auth/AuthProvider';
import { descopeMock } from '../test/mockDescopeSdk';
import { LoginPage } from './LoginPage';

vi.mock('@descope/react-sdk', async () => (await import('../test/mockDescopeSdk')).mockDescopeSdkModule);

function renderLogin(initialEntry: string | { pathname: string; state: unknown } = '/login') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/app/menu" element={<div>Customer menu</div>} />
          <Route path="/org/dashboard" element={<div>Organization dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    descopeMock.reset();
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the Descope sign-up-or-in flow for signed-out users', () => {
    renderLogin();

    expect(screen.getByRole('heading', { name: 'Sign in to Zesto' })).toBeInTheDocument();
    expect(screen.getByTestId('descope-flow')).toHaveAttribute('data-flow-id', 'sign-up-or-in');
    expect(descopeMock.flowProps).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'sign-up-or-in' }));
  });

  it('shows a loading state instead of the flow while the session is still loading', () => {
    descopeMock.setSessionLoading();

    renderLogin();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('descope-flow')).not.toBeInTheDocument();
  });

  it('redirects signed-in users to the route they originally requested', () => {
    descopeMock.setSignedIn();

    renderLogin({ pathname: '/login', state: { from: { pathname: '/org/dashboard' } } });

    expect(screen.getByText('Organization dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('descope-flow')).not.toBeInTheDocument();
  });

  it('redirects signed-in users to the customer menu by default', () => {
    descopeMock.setSignedIn();

    renderLogin();

    expect(screen.getByText('Customer menu')).toBeInTheDocument();
  });
});
