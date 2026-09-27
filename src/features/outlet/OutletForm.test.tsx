import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import { ApiError } from '../../lib/api/client';
import { OutletForm } from './OutletForm';

/**
 * Vitest resolves `@lit/react`'s "node" export condition even under
 * `environment: 'jsdom'`, which ships an SSR-oriented build that never wires
 * up real DOM event listeners (see @lit/react/node/development/create-component.js).
 * That leaves `IonSelect` inert in tests project-wide, not just here — a
 * pre-existing test-environment gap, not something introduced by this
 * component. Stand in a native `<select>` so this file can still verify our
 * own `Controller` wiring (the code we own) without depending on it.
 */
vi.mock('@ionic/react', () => ({
  IonSelect: ({
    label,
    value,
    onIonChange,
    children,
  }: {
    label?: string;
    value?: string;
    onIonChange?: (event: { detail: { value: string } }) => void;
    children?: ReactNode;
  }) => (
    <label>
      {label}
      <select value={value} onChange={(event) => onIonChange?.({ detail: { value: event.target.value } })}>
        {children}
      </select>
    </label>
  ),
  IonSelectOption: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const existingOutlet: Outlet = {
  id: 'outlet-1',
  organizationId: 'org-1',
  name: 'Main Canteen',
  slug: 'main-canteen',
  description: 'Main campus food outlet',
  status: 'active',
  phone: '0499xxxxxxx',
  address: { city: 'Kasaragod', state: 'Kerala' },
  location: { latitude: 12.5, longitude: 74.9 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('OutletForm (create)', () => {
  const onSubmit = vi.fn();
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockReset();
    onSaved.mockReset();
    onCancel.mockReset();
  });

  function renderForm() {
    return render(<OutletForm mode="create" onSubmit={onSubmit} onSaved={onSaved} onCancel={onCancel} />);
  }

  it('associates labels with their inputs for accessibility', () => {
    renderForm();

    expect(screen.getByLabelText('Outlet name')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toBeInTheDocument();
  });

  it('does not show a status control when creating', () => {
    renderForm();

    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
  });

  it('shows a validation error and does not submit when the name is empty', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByText('Outlet name is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a validation error for a slug with invalid characters', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'Not A Slug!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByText('Use lowercase letters, numbers, and single hyphens only.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-suggests a slug from the outlet name until the slug is edited manually', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    expect(screen.getByLabelText('Slug')).toHaveValue('main-canteen');

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'custom-slug' } });
    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Something Else' } });
    expect(screen.getByLabelText('Slug')).toHaveValue('custom-slug');
  });

  it('requires longitude once latitude is set, and validates the range', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByText('Longitude is required when latitude is set.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range latitude', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '74.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByText('Latitude must be between -90 and 90.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the trimmed name/slug and omits untouched optional fields, then calls onSaved', async () => {
    onSubmit.mockResolvedValue(existingOutlet);
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: '  Main Canteen  ' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Main Canteen',
        slug: 'main-canteen',
        description: undefined,
        phone: undefined,
        address: undefined,
        location: undefined,
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(existingOutlet));
  });

  it('assembles address and location from filled-in fields', async () => {
    onSubmit.mockResolvedValue(existingOutlet);
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Kasaragod' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kerala' } });
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '74.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          address: { line1: undefined, line2: undefined, city: 'Kasaragod', state: 'Kerala', postalCode: undefined },
          location: { latitude: 12.5, longitude: 74.9 },
        }),
      ),
    );
  });

  it('shows the slug field as taken on a 409 conflict, without calling onSaved', async () => {
    onSubmit.mockRejectedValue(new ApiError(409, 'already_exists', 'This outlet URL is already taken.'));
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByText('This outlet URL is already taken.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows a permission-denied message on a 403, without calling onSaved', async () => {
    onSubmit.mockRejectedValue(new ApiError(403, 'permission_denied', 'You do not have access to this organization.'));
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to this organization.');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows a backend-unavailable message on a 503, without exposing internals', async () => {
    onSubmit.mockRejectedValue(new ApiError(503, 'unavailable', 'Session validation backend detail.'));
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('disables the submit button while saving', async () => {
    let resolveSubmit: (value: Outlet) => void = () => {};
    onSubmit.mockReturnValue(new Promise<Outlet>((resolve) => (resolveSubmit = resolve)));
    renderForm();

    fireEvent.change(screen.getByLabelText('Outlet name'), { target: { value: 'Main Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'main-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Outlet' }));

    expect(await screen.findByRole('button', { name: 'Adding…' })).toBeDisabled();

    resolveSubmit(existingOutlet);
  });

  it('calls onCancel when Cancel is clicked', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('OutletForm (edit)', () => {
  it('pre-fills fields from the existing outlet', () => {
    render(<OutletForm mode="edit" outlet={existingOutlet} onSubmit={vi.fn()} onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('Outlet name')).toHaveValue('Main Canteen');
    expect(screen.getByLabelText('Description')).toHaveValue('Main campus food outlet');
    expect(screen.getByLabelText('Phone')).toHaveValue('0499xxxxxxx');
    expect(screen.getByLabelText('City')).toHaveValue('Kasaragod');
    expect(screen.getByLabelText('State')).toHaveValue('Kerala');
    expect(screen.getByLabelText('Latitude')).toHaveValue(12.5);
    expect(screen.getByLabelText('Longitude')).toHaveValue(74.9);
  });

  it('shows the slug read-only with an explanation, and never submits it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(existingOutlet);
    render(<OutletForm mode="edit" outlet={existingOutlet} onSubmit={onSubmit} onSaved={vi.fn()} onCancel={vi.fn()} />);

    const slugField = screen.getByLabelText('Slug');
    expect(slugField).toHaveValue('main-canteen');
    expect(slugField).toBeDisabled();
    expect(screen.getByText(/can't be changed after it's created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [submitted] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submitted).not.toHaveProperty('slug');
  });

  it('submits the outlet\'s current status when left unchanged', async () => {
    const onSubmit = vi.fn().mockResolvedValue(existingOutlet);
    render(<OutletForm mode="edit" outlet={existingOutlet} onSubmit={onSubmit} onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' })));
  });

  it('submits a changed status', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ...existingOutlet, status: 'inactive' });
    const onSaved = vi.fn();
    render(<OutletForm mode="edit" outlet={existingOutlet} onSubmit={onSubmit} onSaved={onSaved} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('Status')).toHaveValue('active');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    expect(screen.getByLabelText('Status')).toHaveValue('inactive');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'inactive' })));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...existingOutlet, status: 'inactive' }));
  });

  it('shows an outlet-not-found message on a 404, without calling onSaved', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(404, 'not_found', 'Outlet not found.'));
    const onSaved = vi.fn();
    render(<OutletForm mode="edit" outlet={existingOutlet} onSubmit={onSubmit} onSaved={onSaved} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Outlet not found.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
