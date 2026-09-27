import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { CreateOrganizationForm } from './CreateOrganizationForm';

describe('CreateOrganizationForm', () => {
  const onCreated = vi.fn();
  const createOrganization = vi.fn();

  beforeEach(() => {
    onCreated.mockReset();
    createOrganization.mockReset();
  });

  function renderForm() {
    return render(<CreateOrganizationForm createOrganization={createOrganization} onCreated={onCreated} />);
  }

  it('associates labels with their inputs for accessibility', () => {
    renderForm();

    expect(screen.getByLabelText('Organization name')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
  });

  it('shows a validation error and does not submit when the name is empty', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('Organization name is required.')).toBeInTheDocument();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('shows a validation error for a slug with invalid characters', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'Not A Slug!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('Use lowercase letters, numbers, and single hyphens only.')).toBeInTheDocument();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('auto-suggests a slug from the organization name until the slug is edited manually', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    expect(screen.getByLabelText('Slug')).toHaveValue('test-canteen');

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'custom-slug' } });
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Something Else' } });
    expect(screen.getByLabelText('Slug')).toHaveValue('custom-slug');
  });

  it('submits the exact name and slug to createOrganization on valid input, then calls onCreated', async () => {
    createOrganization.mockResolvedValue({
      id: 'org-1',
      name: 'Test Canteen',
      slug: 'test-canteen',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'U-1',
      role: 'owner',
    });
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'test-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(createOrganization).toHaveBeenCalledWith({ name: 'Test Canteen', slug: 'test-canteen' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it('submits via a real form submit event (keyboard-submit path), not just a button click', async () => {
    createOrganization.mockResolvedValue({
      id: 'org-1',
      name: 'Test Canteen',
      slug: 'test-canteen',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'U-1',
      role: 'owner',
    });
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'test-canteen' } });
    fireEvent.submit(screen.getByLabelText('Slug').closest('form') as HTMLFormElement);

    await waitFor(() => expect(createOrganization).toHaveBeenCalledTimes(1));
  });

  it('shows the slug field as taken on a 409 conflict, without calling onCreated', async () => {
    createOrganization.mockRejectedValue(new ApiError(409, 'already_exists', 'This organization URL is already taken.'));
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'test-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('This organization URL is already taken.')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('shows a backend-unavailable message on a 503, without exposing internals', async () => {
    createOrganization.mockRejectedValue(new ApiError(503, 'unavailable', 'Session validation backend detail.'));
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'test-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('disables the submit button while creating', async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    createOrganization.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderForm();

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Test Canteen' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'test-canteen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();

    resolveCreate({
      id: 'org-1',
      name: 'Test Canteen',
      slug: 'test-canteen',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'U-1',
      role: 'owner',
    });
  });
});
