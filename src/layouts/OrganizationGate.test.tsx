import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api/client';
import { OrganizationGate } from './OrganizationGate';

const getOrganizationsMock = vi.hoisted(() => vi.fn());
vi.mock('../features/organization/api', () => ({
  getOrganizations: getOrganizationsMock,
  createOrganization: vi.fn(),
}));

vi.mock('./OrganizationAppLayout', () => ({
  OrganizationAppLayout: () => <div>Organization dashboard shell</div>,
}));

vi.mock('../pages/organization/OrganizationOnboardingPage', () => ({
  OrganizationOnboardingPage: () => <div>Onboarding page</div>,
}));

const activeOrganization = {
  id: 'org-1',
  name: 'Test Canteen',
  slug: 'test-canteen',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
  role: 'owner',
};

function renderGate(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/org/*" element={<OrganizationGate />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrganizationGate', () => {
  beforeEach(() => {
    getOrganizationsMock.mockReset();
  });

  it('shows a loading state while organizations are being fetched', () => {
    getOrganizationsMock.mockReturnValue(new Promise(() => {}));

    renderGate('/org/dashboard');

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('redirects to onboarding when the caller has zero active organizations', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [] });

    renderGate('/org/dashboard');

    expect(await screen.findByText('Onboarding page')).toBeInTheDocument();
  });

  it('renders the existing organization shell when the caller has an active organization', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [activeOrganization] });

    renderGate('/org/dashboard');

    expect(await screen.findByText('Organization dashboard shell')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the fetch fails', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getOrganizationsMock.mockRejectedValueOnce(error);
    getOrganizationsMock.mockResolvedValueOnce({ organizations: [] });

    renderGate('/org/dashboard');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Zesto is temporarily unavailable. Please try again in a moment.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Onboarding page')).toBeInTheDocument();
    expect(getOrganizationsMock).toHaveBeenCalledTimes(2);
  });

  it('redirects away from onboarding to the dashboard when the caller already has an organization', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [activeOrganization] });

    renderGate('/org/onboarding');

    expect(await screen.findByText('Organization dashboard shell')).toBeInTheDocument();
  });
});
