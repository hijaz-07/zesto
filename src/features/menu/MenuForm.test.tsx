import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { CreateMenuInput, UpdateMenuInput } from './api';
import { MenuForm } from './MenuForm';
import type { Menu } from './types';

const NOW = '2026-09-28T12:00:00+05:30';

function buildMenu(overrides: Partial<Menu> = {}): Menu {
  return {
    id: 'menu-1',
    organizationId: 'org-1',
    outletId: 'outlet-1',
    menuDate: '2026-09-29',
    title: 'Tuesday Special',
    description: "Chef's picks",
    status: 'draft',
    orderingOpensAt: '2026-09-28T08:00:00+05:30',
    orderingClosesAt: '2026-09-29T10:00:00+05:30',
    pickupStartsAt: '2026-09-29T12:00:00+05:30',
    pickupEndsAt: '2026-09-29T14:00:00+05:30',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'U-1',
    ...overrides,
  };
}

/** Fills every schedule field with a mutually-consistent, valid set of values. */
function fillValidSchedule() {
  fireEvent.change(screen.getByLabelText('Menu date'), { target: { value: '2026-09-29' } });
  fireEvent.change(screen.getByLabelText('Opens date'), { target: { value: '2026-09-28' } });
  fireEvent.change(screen.getByLabelText('Opens time'), { target: { value: '08:00' } });
  fireEvent.change(screen.getByLabelText('Closes date'), { target: { value: '2026-09-29' } });
  fireEvent.change(screen.getByLabelText('Closes time'), { target: { value: '10:00' } });
  fireEvent.change(screen.getByLabelText('Starts date'), { target: { value: '2026-09-29' } });
  fireEvent.change(screen.getByLabelText('Starts time'), { target: { value: '12:00' } });
  fireEvent.change(screen.getByLabelText('Ends date'), { target: { value: '2026-09-29' } });
  fireEvent.change(screen.getByLabelText('Ends time'), { target: { value: '14:00' } });
}

beforeEach(() => {
  // Date-only mock (no vi.useFakeTimers()): tests below `await`/`findBy`, which
  // rely on real timers for their own polling — faking timers wholesale would
  // hang them, since RTL's async utilities schedule via the now-fake clock.
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MenuForm (create)', () => {
  const onSubmit = vi.fn<(input: CreateMenuInput) => Promise<Menu>>();
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockReset();
    onSaved.mockReset();
    onCancel.mockReset();
  });

  function renderForm() {
    return render(<MenuForm mode="create" onSubmit={onSubmit} onSaved={onSaved} onCancel={onCancel} />);
  }

  it('6. starts with every field empty and the Create Draft action, never offering to publish immediately', () => {
    renderForm();

    expect(screen.getByLabelText('Menu date')).toHaveValue('');
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Opens date')).toHaveValue('');
    expect(screen.getByLabelText('Ends time')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create Draft' })).toBeInTheDocument();
    expect(screen.queryByText(/publish immediately/i)).not.toBeInTheDocument();
  });

  it('7. requires a non-blank title', async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText('Title is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('8. rejects a description over 500 characters', async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'x'.repeat(501) } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText('Must be 500 characters or fewer.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("9. rejects a menu date before today in Zesto's business time zone", async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Menu date'), { target: { value: '2026-09-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText("Menu date can't be before today.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('10. rejects an ordering window that closes before it opens', async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Opens time'), { target: { value: '11:00' } });
    fireEvent.change(screen.getByLabelText('Closes time'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('Opens date'), { target: { value: '2026-09-29' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText('Ordering must open before it closes.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('11. rejects a pickup window that ends before it starts', async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Starts time'), { target: { value: '15:00' } });
    fireEvent.change(screen.getByLabelText('Ends time'), { target: { value: '14:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText('Pickup must start before it ends.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('12. rejects pickup starting before ordering closes', async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Closes time'), { target: { value: '13:00' } });
    fireEvent.change(screen.getByLabelText('Starts time'), { target: { value: '12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText('Ordering must close at or before pickup starts.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("12b. rejects pickup starting before the menu's own date", async () => {
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Menu date'), { target: { value: '2026-09-30' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText("Pickup can't start before the menu date.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('13. converts calendar date + time into an Asia/Kolkata ISO timestamp on submit', async () => {
    onSubmit.mockResolvedValue(buildMenu());
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Tuesday Special  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        title: 'Tuesday Special',
        description: undefined,
        menuDate: '2026-09-29',
        orderingOpensAt: '2026-09-28T08:00:00+05:30',
        orderingClosesAt: '2026-09-29T10:00:00+05:30',
        pickupStartsAt: '2026-09-29T12:00:00+05:30',
        pickupEndsAt: '2026-09-29T14:00:00+05:30',
      }),
    );
  });

  it('14. calls onSaved with the created menu on success', async () => {
    const created = buildMenu();
    onSubmit.mockResolvedValue(created);
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
  });

  it('15. shows a backend-safe message and does not call onSaved when create fails', async () => {
    onSubmit.mockRejectedValue(new ApiError(400, 'invalid_argument', 'This outlet is not active.'));
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByText('This outlet is not active.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('16. disables the submit button and shows "Creating…" while saving', async () => {
    let resolveSubmit: (value: Menu) => void = () => {};
    onSubmit.mockReturnValue(new Promise<Menu>((resolve) => (resolveSubmit = resolve)));
    renderForm();
    fillValidSchedule();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();

    resolveSubmit(buildMenu());
  });

  it('calls onCancel when Cancel is clicked', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('MenuForm (edit)', () => {
  const onSubmit = vi.fn<(input: UpdateMenuInput) => Promise<Menu>>();
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockReset();
    onSaved.mockReset();
    onCancel.mockReset();
  });

  function renderForm(menu: Menu) {
    return render(<MenuForm mode="edit" menu={menu} onSubmit={onSubmit} onSaved={onSaved} onCancel={onCancel} />);
  }

  it('19. populates every field from the existing menu', () => {
    renderForm(buildMenu());

    expect(screen.getByLabelText('Menu date')).toHaveValue('2026-09-29');
    expect(screen.getByLabelText('Title')).toHaveValue('Tuesday Special');
    expect(screen.getByLabelText('Description')).toHaveValue("Chef's picks");
    expect(screen.getByLabelText('Opens date')).toHaveValue('2026-09-28');
    expect(screen.getByLabelText('Opens time')).toHaveValue('08:00');
    expect(screen.getByLabelText('Closes date')).toHaveValue('2026-09-29');
    expect(screen.getByLabelText('Closes time')).toHaveValue('10:00');
    expect(screen.getByLabelText('Starts date')).toHaveValue('2026-09-29');
    expect(screen.getByLabelText('Starts time')).toHaveValue('12:00');
    expect(screen.getByLabelText('Ends date')).toHaveValue('2026-09-29');
    expect(screen.getByLabelText('Ends time')).toHaveValue('14:00');
  });

  it('20. A. draft: every field is editable', () => {
    renderForm(buildMenu({ status: 'draft' }));

    expect(screen.getByLabelText('Menu date')).toBeEnabled();
    expect(screen.getByLabelText('Title')).toBeEnabled();
    expect(screen.getByLabelText('Opens date')).toBeEnabled();
    expect(screen.getByLabelText('Ends time')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('21. B. published + not open: every field is editable', () => {
    renderForm(
      buildMenu({
        status: 'published',
        orderingOpensAt: '2026-09-30T08:00:00+05:30',
        orderingClosesAt: '2026-09-30T10:00:00+05:30',
      }),
    );

    expect(screen.getByLabelText('Menu date')).toBeEnabled();
    expect(screen.getByLabelText('Opens date')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('22. C. published + open: every field is editable', () => {
    renderForm(
      buildMenu({
        status: 'published',
        orderingOpensAt: '2026-09-28T08:00:00+05:30',
        orderingClosesAt: '2026-09-28T18:00:00+05:30',
      }),
    );

    expect(screen.getByLabelText('Menu date')).toBeEnabled();
    expect(screen.getByLabelText('Opens date')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('23. D. published + closed: schedule fields are locked, title/description stay editable, and an explanation is shown', () => {
    renderForm(
      buildMenu({
        status: 'published',
        orderingOpensAt: '2026-09-28T04:00:00+05:30',
        orderingClosesAt: '2026-09-28T10:00:00+05:30',
      }),
    );

    expect(screen.getByLabelText('Menu date')).toBeDisabled();
    expect(screen.getByLabelText('Opens date')).toBeDisabled();
    expect(screen.getByLabelText('Opens time')).toBeDisabled();
    expect(screen.getByLabelText('Closes date')).toBeDisabled();
    expect(screen.getByLabelText('Ends time')).toBeDisabled();
    expect(screen.getByLabelText('Title')).toBeEnabled();
    expect(screen.getByLabelText('Description')).toBeEnabled();
    expect(screen.getByText('Ordering has closed. Schedule changes are no longer available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('23b. omits schedule fields from the update payload once the schedule is locked', async () => {
    const menu = buildMenu({
      status: 'published',
      orderingOpensAt: '2026-09-28T04:00:00+05:30',
      orderingClosesAt: '2026-09-28T10:00:00+05:30',
    });
    onSubmit.mockResolvedValue(menu);
    renderForm(menu);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ title: 'Updated title', description: "Chef's picks" }),
    );
  });

  it('24. E. archived: everything is read-only and there is no Save button', () => {
    renderForm(buildMenu({ status: 'archived' }));

    expect(screen.getByLabelText('Menu date')).toBeDisabled();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByLabelText('Opens date')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('25. calls onSaved with the updated menu on success', async () => {
    const menu = buildMenu();
    const updated = { ...menu, title: 'Updated title' };
    onSubmit.mockResolvedValue(updated);
    renderForm(menu);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  });

  it('26. shows a backend-safe message and does not call onSaved when save fails', async () => {
    const menu = buildMenu();
    onSubmit.mockRejectedValue(new ApiError(404, 'not_found', 'Menu not found.'));
    renderForm(menu);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Menu not found.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('disables Save/Cancel and shows "Saving…" while saving', async () => {
    const menu = buildMenu();
    let resolveSubmit: (value: Menu) => void = () => {};
    onSubmit.mockReturnValue(new Promise<Menu>((resolve) => (resolveSubmit = resolve)));
    renderForm(menu);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolveSubmit(menu);
  });
});
