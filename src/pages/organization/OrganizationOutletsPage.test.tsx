import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import { ApiError } from '../../lib/api/client';
import { useOutlets } from '../../features/outlet/useOutlets';
import { OrganizationOutletsPage } from './OrganizationOutletsPage';

vi.mock('../../features/outlet/useOutlets');

const mockedUseOutlets = vi.mocked(useOutlets);

const activeOutlet: Outlet = {
  id: 'outlet-1',
  organizationId: 'org-1',
  name: 'Main Canteen',
  slug: 'main-canteen',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
};

const inactiveOutlet: Outlet = { ...activeOutlet, id: 'outlet-2', name: 'Old Kiosk', status: 'inactive' };

function mockOutlets(overrides: Partial<ReturnType<typeof useOutlets>>) {
  mockedUseOutlets.mockReturnValue({
    status: 'ready',
    outlets: [],
    error: null,
    retry: vi.fn(),
    createOutlet: vi.fn(),
    updateOutlet: vi.fn(),
    ...overrides,
  });
}

describe('OrganizationOutletsPage', () => {
  beforeEach(() => {
    mockedUseOutlets.mockReset();
  });

  it('shows a loading state while outlets are being fetched', () => {
    mockOutlets({ status: 'loading', outlets: [] });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an empty state with an Add Outlet action when the organization has no outlets', () => {
    mockOutlets({ status: 'ready', outlets: [] });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    expect(screen.getByText('No outlets yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add Outlet/ }).length).toBeGreaterThan(0);
  });

  it('does not show an error state for an empty list', () => {
    mockOutlets({ status: 'ready', outlets: [] });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a card per outlet when outlets exist, including inactive status', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet, inactiveOutlet] });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('Old Kiosk')).toBeInTheDocument();
    expect(screen.getByText('INACTIVE')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the fetch fails', () => {
    const retry = vi.fn();
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    mockOutlets({ status: 'error', outlets: [], error, retry });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable. Please try again in a moment.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('opens the creation form when Add Outlet is clicked, and back to the list on cancel', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Add Outlet/ }));

    expect(screen.getByLabelText('Outlet name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Outlet' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Outlet name')).not.toBeInTheDocument();
    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
  });

  it('creates an outlet via useOutlets().createOutlet, then closes the form back to the list', async () => {
    // useOutlets is mocked wholesale here, so its returned `outlets` array is
    // static — the real hook (already covered by useOutlets.test.ts) is what
    // actually appends the created outlet. This test only proves the page
    // wires the form to createOutlet and returns to list view on success.
    const createOutlet = vi.fn().mockResolvedValue(activeOutlet);
    mockOutlets({ status: 'ready', outlets: [], createOutlet });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    fireEvent.click(screen.getAllByRole('button', { name: /Add Outlet/ })[0]);
    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    await waitFor(() =>
      expect(createOutlet).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Main Canteen', slug: 'main-canteen' }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText('Outlet name')).not.toBeInTheDocument());
    expect(screen.getByText('No outlets yet')).toBeInTheDocument();
  });

  it("opens the edit form pre-filled with the outlet's existing values", () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));

    expect(screen.getByLabelText('Outlet name')).toHaveValue('Main Canteen');
    expect(screen.getByLabelText('Slug')).toHaveValue('main-canteen');
    expect(screen.getByLabelText('Slug')).toBeDisabled();
  });

  it('updates an outlet via useOutlets().updateOutlet, then closes the form back to the list', async () => {
    // Same boundary as the create test above: useOutlets is fully mocked, so
    // its `outlets` array stays static here regardless of what updateOutlet
    // resolves with. This proves the page calls updateOutlet with the right
    // outlet id/payload and returns to list view on success.
    const updateOutlet = vi.fn().mockResolvedValue({ ...activeOutlet, name: 'Main Canteen (Renamed)' });
    mockOutlets({ status: 'ready', outlets: [activeOutlet], updateOutlet });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen (Renamed)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateOutlet).toHaveBeenCalledWith('outlet-1', expect.objectContaining({ name: 'Main Canteen (Renamed)' })),
    );
    await waitFor(() => expect(screen.queryByLabelText('Outlet name')).not.toBeInTheDocument());
    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
  });

  it('shows a permission-denied message on a forbidden create, without leaving the form', async () => {
    const createOutlet = vi.fn().mockRejectedValue(
      new ApiError(403, 'permission_denied', 'You do not have access to this organization.'),
    );
    mockOutlets({ status: 'ready', outlets: [], createOutlet });

    render(<OrganizationOutletsPage organizationId="org-1" />);

    fireEvent.click(screen.getAllByRole('button', { name: /Add Outlet/ })[0]);
    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to this organization.');
    expect(screen.getByLabelText('Outlet name')).toBeInTheDocument();
  });
});
