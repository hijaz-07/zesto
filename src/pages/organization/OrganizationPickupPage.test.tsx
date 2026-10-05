import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationMemberRole } from '../../domain/types';
import { redeemPickup, runFulfillmentAction } from '../../features/organizationOrder/api';
import type { OrganizationOrderSummary } from '../../features/organizationOrder/types';
import { getOutlets } from '../../features/outlet/api';
import { ApiError } from '../../lib/api/client';
import { completedOrgOrder, orgOutlets, pickedUpOrgOrder } from '../../test/organizationOrderFixtures';
import { watchPersistence, type PersistenceGuard } from '../../test/persistenceGuard';
import { OrganizationPickupPage } from './OrganizationPickupPage';

vi.mock('../../features/organizationOrder/api');
vi.mock('../../features/outlet/api');

const mockedRedeem = vi.mocked(redeemPickup);
const mockedRun = vi.mocked(runFulfillmentAction);
const mockedGetOutlets = vi.mocked(getOutlets);

const CODE = 'K7QX-4M2P';
const QR = 'ZP1.order-picked-up-7.AbCdEfGhIjKlMnOpQrStUv';

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage(role: OrganizationMemberRole = 'staff', organizationId = 'org-1') {
  return render(
    <MemoryRouter initialEntries={['/org/pickup']}>
      <OrganizationPickupPage organizationId={organizationId} role={role} />
    </MemoryRouter>,
  );
}

const field = () => screen.getByRole('textbox', { name: 'Pickup code' }) as HTMLInputElement;
const handOver = () => screen.getByRole('button', { name: /Hand over|Handing over…/ });

function type(value: string) {
  fireEvent.change(field(), { target: { value } });
}

/** Types `value` and presses "Hand over". */
function submitCode(value = CODE) {
  type(value);
  fireEvent.click(handOver());
}

describe('OrganizationPickupPage', () => {
  let guard: PersistenceGuard;

  beforeEach(() => {
    mockedRedeem.mockReset();
    mockedRun.mockReset();
    mockedGetOutlets.mockReset();
    mockedGetOutlets.mockResolvedValue({ outlets: orgOutlets });
    mockedRedeem.mockResolvedValue(pickedUpOrgOrder);
    guard = watchPersistence();
  });

  afterEach(() => {
    guard.restore();
  });

  describe('who gets the controls', () => {
    it.each(['owner', 'manager', 'staff'] as const)('shows the pickup controls to an %s', async (role) => {
      renderPage(role);

      expect(screen.getByRole('heading', { level: 1, name: 'Pickup' })).toBeInTheDocument();
      expect(field()).toBeEnabled();
      expect(handOver()).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Outlet' })).toBeInTheDocument();
      await waitFor(() => expect(mockedGetOutlets).toHaveBeenCalledWith('org-1'));
    });

    it.each(['visitor', 'superadmin', '', null])(
      'shows no controls to a role it does not know (%j): only that they have no access, and fetches nothing',
      (role) => {
        renderPage(role as unknown as OrganizationMemberRole);

        expect(screen.getByRole('alert')).toHaveTextContent("You don't have access to hand over orders");
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(mockedGetOutlets).not.toHaveBeenCalled();
        expect(mockedRedeem).not.toHaveBeenCalled();
      },
    );
  });

  describe('the form', () => {
    it('does not name, auto-complete, auto-correct or spell-check the field, so the browser keeps no history of a code', () => {
      renderPage();

      const input = field();
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('autocorrect', 'off');
      expect(input).toHaveAttribute('autocapitalize', 'characters');
      expect(input).toHaveAttribute('spellcheck', 'false');
      expect(input).not.toHaveAttribute('name');
      expect(input).toHaveAttribute('type', 'text');
    });

    it('keeps "Hand over" disabled until something is typed', () => {
      renderPage();

      expect(handOver()).toBeDisabled();
      type('   ');
      expect(handOver()).toBeDisabled();
      type('K7');
      expect(handOver()).toBeEnabled();
    });

    it('puts the cursor in the field when the page opens, ready for a scanner or typing', () => {
      renderPage();

      expect(document.activeElement).toBe(field());
    });
  });

  describe('the outlet selector', () => {
    it('starts on All outlets and lists the organization\'s outlets, including a deactivated one', async () => {
      renderPage();

      const select = screen.getByRole('combobox', { name: 'Outlet' }) as HTMLSelectElement;
      await waitFor(() => expect(select).toBeEnabled());
      expect(select.value).toBe('');
      expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'All outlets',
        'Main Canteen',
        'Hostel Café',
        'Old Annex (inactive)',
      ]);
    });

    it('sends no outlet when All outlets is chosen, and the chosen outlet otherwise', async () => {
      renderPage();
      const select = screen.getByRole('combobox', { name: 'Outlet' });
      await waitFor(() => expect(select).toBeEnabled());

      submitCode();
      await waitFor(() => expect(mockedRedeem).toHaveBeenCalledTimes(1));
      expect(mockedRedeem).toHaveBeenLastCalledWith('org-1', { credential: CODE, outletId: undefined });

      fireEvent.change(select, { target: { value: 'outlet-2' } });
      await screen.findByRole('status');
      fireEvent.click(screen.getByRole('button', { name: 'Next pickup' }));
      submitCode();
      await waitFor(() => expect(mockedRedeem).toHaveBeenCalledTimes(2));
      expect(mockedRedeem).toHaveBeenLastCalledWith('org-1', { credential: CODE, outletId: 'outlet-2' });
    });

    it('still lets staff hand orders over when the outlets cannot be loaded', async () => {
      mockedGetOutlets.mockRejectedValue(new ApiError(503, 'unavailable', 'down'));
      renderPage();

      await waitFor(() => expect(mockedGetOutlets).toHaveBeenCalled());
      expect(screen.getByRole('combobox', { name: 'Outlet' })).toBeDisabled();
      submitCode();

      await screen.findByText('Order #order-picked-up-7');
      expect(mockedRedeem).toHaveBeenCalledTimes(1);
    });
  });

  describe('a successful pickup', () => {
    it('sends the normalized code for this organization, and shows what to hand over', async () => {
      renderPage('staff', 'org-7');

      submitCode('k7qx 4m2p');

      expect(await screen.findByText('Order #order-picked-up-7')).toBeInTheDocument();
      expect(mockedRedeem).toHaveBeenCalledWith('org-7', { credential: CODE, outletId: undefined });
      const card = screen.getByRole('status');
      expect(within(card).getByText('Picked up')).toBeInTheDocument();
      expect(within(card).getByText('Main Canteen')).toBeInTheDocument();
      expect(within(card).getByText('Chicken Biriyani × 2')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Mark completed' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('accepts a pasted QR payload, or one typed by a keyboard-wedge scanner (ending in Enter)', async () => {
      renderPage();

      type(`${QR}\n`);
      fireEvent.submit(field().closest('form') as HTMLFormElement);

      await screen.findByText('Order #order-picked-up-7');
      expect(mockedRedeem).toHaveBeenCalledWith('org-1', { credential: QR, outletId: undefined });
    });

    it('submits on Enter in the field, as a wedge scanner does', async () => {
      renderPage();
      type(CODE);

      fireEvent.submit(field().closest('form') as HTMLFormElement);

      await screen.findByText('Order #order-picked-up-7');
      expect(mockedRedeem).toHaveBeenCalledTimes(1);
    });

    it('shows no customer identity, provider data or audit field — and not the credential', async () => {
      mockedRedeem.mockResolvedValue({
        ...pickedUpOrgOrder,
        userId: 'U-secret-customer',
        customerEmail: 'asha@example.com',
        pickedUpBy: 'U-secret-staff',
      } as OrganizationOrderSummary);
      renderPage();

      submitCode();

      await screen.findByText('Order #order-picked-up-7');
      const text = document.body.textContent ?? '';
      for (const secret of ['U-secret-customer', 'asha@example.com', 'U-secret-staff', 'K7QX', 'ZP1']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe('while the request is in flight', () => {
    it('disables the field, the outlet and the button, says what is happening, and ignores a second submit', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);
      renderPage();
      type(CODE);

      fireEvent.click(handOver());

      const busy = await screen.findByRole('button', { name: 'Handing over…' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      expect(field()).toBeDisabled();
      expect(screen.getByRole('combobox', { name: 'Outlet' })).toBeDisabled();
      fireEvent.click(busy);
      fireEvent.submit(field().closest('form') as HTMLFormElement);
      expect(mockedRedeem).toHaveBeenCalledTimes(1);

      await act(async () => request.resolve(pickedUpOrgOrder));
      await screen.findByText('Order #order-picked-up-7');
    });

    it('clears the credential from the field the moment it is sent — before the answer comes back', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);
      renderPage();

      submitCode();

      await screen.findByRole('button', { name: 'Handing over…' });
      expect(field().value).toBe('');
      await act(async () => request.resolve(pickedUpOrgOrder));
    });
  });

  describe('after every attempt the credential is gone and the cursor is back in the field', () => {
    it.each([
      ['a successful pickup', () => mockedRedeem.mockResolvedValue(pickedUpOrgOrder)],
      ['a refusal', () => mockedRedeem.mockRejectedValue(new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'))],
      ['a network failure', () => mockedRedeem.mockRejectedValue(new TypeError('Failed to fetch'))],
    ])('after %s', async (_label, arrange) => {
      arrange();
      renderPage();

      submitCode();

      await waitFor(() => expect(screen.getByRole('button', { name: 'Hand over' })).toBeInTheDocument());
      expect(field().value).toBe('');
      expect(document.activeElement).toBe(field());
      expect(document.body.innerHTML).not.toContain('K7QX');
    });

    it('also clears it when the input was not a pickup code at all', async () => {
      renderPage();

      submitCode('hello');

      expect(await screen.findByRole('alert')).toHaveTextContent("That doesn't look like a Zesto pickup code");
      expect(field().value).toBe('');
    });
  });

  describe('errors', () => {
    it('does not send input that plainly is not a pickup code, and says so', async () => {
      renderPage();

      submitCode('K7QX');

      expect(await screen.findByRole('alert')).toHaveTextContent("That doesn't look like a Zesto pickup code");
      expect(mockedRedeem).not.toHaveBeenCalled();
      expect(screen.queryByText('Mark completed')).not.toBeInTheDocument();
    });

    it.each([
      ['an invalid or foreign credential (404)', new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'), 'No order awaiting pickup matches this code.'],
      ['a refused request (400)', new ApiError(400, 'invalid_argument', "That doesn't look like a Zesto pickup code."), "That doesn't look like a Zesto pickup code."],
      ['an order already picked up (409)', new ApiError(409, 'conflict', 'This order has already been picked up.'), 'This order has already been picked up.'],
      ['an order not ready (409)', new ApiError(409, 'conflict', 'This order is not ready for pickup yet.'), 'This order is not ready for pickup yet.'],
      ['an order for another outlet (409)', new ApiError(409, 'conflict', 'This order is for a different outlet.'), 'This order is for a different outlet.'],
      ['no access (403)', new ApiError(403, 'permission_denied', 'No.'), "You don't have access to hand over orders."],
      ['an expired session (401)', new ApiError(401, 'unauthenticated', 'x'), 'Your session has expired. Please sign in again.'],
      ['the service being down (503)', new ApiError(503, 'unavailable', 'x'), 'Zesto is temporarily unavailable. Nothing was recorded. Please try again in a moment.'],
    ])('shows %s as an alert and no pickup', async (_label, failure, message) => {
      mockedRedeem.mockRejectedValue(failure);
      renderPage();

      submitCode();

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByText('Picked up')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument();
    });

    it('after a network failure, says the pickup may or may not have been recorded, and shows no pickup', async () => {
      mockedRedeem.mockRejectedValue(new TypeError('Failed to fetch'));
      renderPage();

      submitCode();

      expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been recorded');
      expect(screen.queryByText('Picked up')).not.toBeInTheDocument();
    });

    it('never says anything that distinguishes a foreign order from a wrong code', async () => {
      mockedRedeem.mockRejectedValue(new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'));
      renderPage();

      submitCode();

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).not.toMatch(/organization|another|belongs|exists|foreign|other org/i);
    });

    it('clears the error when the next attempt succeeds', async () => {
      mockedRedeem.mockRejectedValueOnce(new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'));
      renderPage();
      submitCode();
      await screen.findByRole('alert');

      submitCode();

      await screen.findByText('Order #order-picked-up-7');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('never leaves an earlier success on screen beside a later failure', async () => {
      renderPage();
      submitCode();
      await screen.findByText('Order #order-picked-up-7');
      mockedRedeem.mockRejectedValue(new ApiError(409, 'conflict', 'This order has already been picked up.'));

      submitCode(QR);

      expect(await screen.findByRole('alert')).toHaveTextContent('This order has already been picked up.');
      expect(screen.queryByText('Order #order-picked-up-7')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument();
    });

    it('does not show a response that is not a picked-up order as a success', async () => {
      mockedRedeem.mockRejectedValue(new ApiError(200, 'invalid_response', 'odd'));
      renderPage();

      submitCode();

      expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been recorded');
      expect(screen.queryByText('Picked up')).not.toBeInTheDocument();
    });
  });

  describe('completing the order', () => {
    const completedRow = { ...completedOrgOrder, id: pickedUpOrgOrder.id };

    async function pickedUp() {
      renderPage('staff', 'org-9');
      submitCode();
      await screen.findByText('Order #order-picked-up-7');
    }

    it('asks the backend to complete exactly that order, with no confirmation step', async () => {
      mockedRun.mockResolvedValue(completedRow);
      await pickedUp();

      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));

      await waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(1));
      expect(mockedRun).toHaveBeenCalledWith('org-9', 'order-picked-up-7', 'complete');
      expect(screen.queryByRole('group')).not.toBeInTheDocument();
    });

    it('shows Completed, and no completion action is left', async () => {
      mockedRun.mockResolvedValue(completedRow);
      await pickedUp();

      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));

      expect(await screen.findByText('This order is complete.')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Mark completed|Completing/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('prevents a duplicate: the button is disabled while the request is in flight', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRun.mockReturnValue(request.promise);
      await pickedUp();

      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));

      const busy = await screen.findByRole('button', { name: 'Completing…' });
      expect(busy).toBeDisabled();
      fireEvent.click(busy);
      expect(mockedRun).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Next pickup' })).toBeDisabled();

      await act(async () => request.resolve(completedRow));
      await screen.findByText('This order is complete.');
    });

    it.each([
      ['a 409', new ApiError(409, 'conflict', 'This order has not been picked up yet.'), 'This order has not been picked up yet.'],
      ['a 403', new ApiError(403, 'permission_denied', 'x'), "You don't have access to change this order."],
      ['a 503', new ApiError(503, 'unavailable', 'x'), 'Zesto is temporarily unavailable. Please try again in a moment.'],
      ['a network failure', new TypeError('Failed to fetch'), "Couldn't reach Zesto. Please check your connection and try again."],
    ])('on %s: keeps the picked-up order and shows why, ready to try again', async (_label, failure, message) => {
      mockedRun.mockRejectedValueOnce(failure);
      mockedRun.mockResolvedValueOnce(completedRow);
      await pickedUp();

      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByText('Picked up')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
      expect(await screen.findByText('This order is complete.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('"Next pickup" clears the card and puts the cursor back in the field', async () => {
      mockedRun.mockResolvedValue(completedRow);
      await pickedUp();
      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
      await screen.findByText('This order is complete.');

      fireEvent.click(screen.getByRole('button', { name: 'Next pickup' }));

      expect(screen.queryByText('Order #order-picked-up-7')).not.toBeInTheDocument();
      await waitFor(() => expect(document.activeElement).toBe(field()));
    });
  });

  describe('Scan QR', () => {
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const getUserMedia = vi.fn();
    const detect = vi.fn();
    let supportedFormats: string[] | Error = ['qr_code'];

    class FakeBarcodeDetector {
      static getSupportedFormats = async () => {
        if (supportedFormats instanceof Error) {
          throw supportedFormats;
        }
        return supportedFormats;
      };
      detect = detect;
    }

    function stubScanner() {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
      vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
    }

    beforeEach(() => {
      getUserMedia.mockReset();
      detect.mockReset();
      detect.mockResolvedValue([]);
      supportedFormats = ['qr_code'];
      getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (originalMediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
      } else {
        delete (navigator as { mediaDevices?: unknown }).mediaDevices;
      }
    });

    it('is not offered where the browser has no camera or no QR reader — and typing the code works', async () => {
      renderPage();

      await act(async () => {});
      expect(screen.queryByRole('button', { name: 'Scan QR' })).not.toBeInTheDocument();
      submitCode();
      await screen.findByText('Order #order-picked-up-7');
    });

    it('is not offered when a BarcodeDetector exists but cannot read QR codes', async () => {
      stubScanner();
      supportedFormats = ['ean_13'];
      renderPage();

      await act(async () => {});

      expect(screen.queryByRole('button', { name: 'Scan QR' })).not.toBeInTheDocument();
    });

    it('is not offered when the browser cannot even say what it supports', async () => {
      stubScanner();
      supportedFormats = new Error('boom');
      renderPage();

      await act(async () => {});

      expect(screen.queryByRole('button', { name: 'Scan QR' })).not.toBeInTheDocument();
    });

    it('is offered where the browser can really scan', async () => {
      stubScanner();
      renderPage();

      expect(await screen.findByRole('button', { name: 'Scan QR' })).toBeEnabled();
    });

    it('is not offered while it is still being checked, so it never flashes up on a browser that cannot use it', () => {
      stubScanner();
      FakeBarcodeDetector.getSupportedFormats = () => new Promise(() => {});
      renderPage();

      expect(screen.queryByRole('button', { name: 'Scan QR' })).not.toBeInTheDocument();
      FakeBarcodeDetector.getSupportedFormats = async () => ['qr_code'];
    });

    it('opens the camera panel, reads a code, hands the order over, and closes the camera', async () => {
      stubScanner();
      const stop = vi.fn();
      getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
      detect.mockResolvedValue([{ rawValue: QR }]);
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Scan QR' }));
      expect(screen.getByRole('button', { name: 'Cancel scanning' })).toBeInTheDocument();

      expect(await screen.findByText('Order #order-picked-up-7', {}, { timeout: 3000 })).toBeInTheDocument();
      expect(mockedRedeem).toHaveBeenCalledTimes(1);
      expect(mockedRedeem).toHaveBeenCalledWith('org-1', { credential: QR, outletId: undefined });
      expect(screen.queryByRole('button', { name: 'Cancel scanning' })).not.toBeInTheDocument();
      expect(stop).toHaveBeenCalled();
      expect(field().value).toBe('');
    });

    it('treats a scanned code that is not a pickup code as an error, without sending anything', async () => {
      stubScanner();
      detect.mockResolvedValue([{ rawValue: 'https://example.com/not-a-pickup-code' }]);
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Scan QR' }));

      expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent("That doesn't look like a Zesto pickup code");
      expect(mockedRedeem).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Cancel scanning' })).not.toBeInTheDocument();
    });

    it('cancelling the scan closes the panel and releases the camera, and sends nothing', async () => {
      stubScanner();
      const stop = vi.fn();
      getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Scan QR' }));
      await screen.findByText("Point the camera at the customer's QR code.");

      fireEvent.click(screen.getByRole('button', { name: 'Cancel scanning' }));

      expect(screen.queryByRole('button', { name: 'Cancel scanning' })).not.toBeInTheDocument();
      expect(stop).toHaveBeenCalled();
      expect(mockedRedeem).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Scan QR' })).toBeInTheDocument();
    });

    it.each([
      ['permission is denied', 'NotAllowedError', 'Camera access was blocked'],
      ['there is no camera', 'NotFoundError', 'No camera was found on this device'],
      ['the camera will not start', 'NotReadableError', "The camera couldn't be started"],
    ])('when %s: shows it in the scanner panel and leaves typing the code fully working', async (_label, name, message) => {
      stubScanner();
      getUserMedia.mockRejectedValue(Object.assign(new Error('camera'), { name }));
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Scan QR' }));

      expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
      // The page is intact: the field, the outlet and the buttons are all still there and usable.
      expect(field()).toBeEnabled();
      expect(screen.getByRole('heading', { level: 1, name: 'Pickup' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      submitCode();
      await screen.findByText('Order #order-picked-up-7');
    });

    it('does not let a second scan start a second request while one is in flight', async () => {
      stubScanner();
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);
      detect.mockResolvedValue([{ rawValue: QR }]);
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Scan QR' }));
      await screen.findByRole('button', { name: 'Handing over…' }, { timeout: 3000 });

      expect(screen.queryByRole('button', { name: 'Scan QR' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Scan QR' })).toBeDisabled();
      expect(mockedRedeem).toHaveBeenCalledTimes(1);
      await act(async () => request.resolve(pickedUpOrgOrder));
    });
  });

  describe('the credential stays in memory', () => {
    it('writes nothing to localStorage, sessionStorage, IndexedDB, cookies, history or the URL, whatever the outcome', async () => {
      renderPage();

      submitCode();
      await screen.findByText('Order #order-picked-up-7');
      mockedRedeem.mockRejectedValueOnce(new ApiError(409, 'conflict', 'This order has already been picked up.'));
      fireEvent.click(screen.getByRole('button', { name: 'Next pickup' }));
      submitCode(QR);
      await screen.findByRole('alert');
      mockedRedeem.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      submitCode(CODE);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('may or may not'));

      guard.expectNothingPersisted([CODE, 'K7QX4M2P', QR, 'AbCdEfGhIjKlMnOpQrStUv']);
    });
  });
});
