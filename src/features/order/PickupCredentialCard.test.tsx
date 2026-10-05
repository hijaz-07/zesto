import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { PickupCredentialCard } from './PickupCredentialCard';
import type { UseOrderPickupResult } from './useOrderPickup';

const credential = { qrPayload: 'ZP1.kQ3vR8nT2xLpA7mZdW1e.AbCdEfGhIjKlMnOpQrStUv', code: 'K7QX-4M2P' };

function pickup(overrides: Partial<UseOrderPickupResult> = {}): UseOrderPickupResult {
  return { status: 'ready', credential, error: null, retry: vi.fn(), ...overrides };
}

describe('PickupCredentialCard', () => {
  it('renders nothing at all while there is no credential to show (the order is not ready)', () => {
    const { container } = render(<PickupCredentialCard pickup={pickup({ status: 'idle', credential: null })} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading state while the credential is being fetched', () => {
    render(<PickupCredentialCard pickup={pickup({ status: 'loading', credential: null })} />);

    expect(screen.getByRole('heading', { name: 'Collect your order' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your pickup code…');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  describe('with a credential', () => {
    it('shows the QR code, the backup code and an instruction to show them to staff', () => {
      render(<PickupCredentialCard pickup={pickup()} />);

      expect(screen.getByRole('heading', { name: 'Collect your order' })).toBeInTheDocument();
      expect(screen.getByText(/Show the QR code to staff when you collect your order/)).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Pickup QR code' })).toBeInTheDocument();
      expect(screen.getByText('Pickup code')).toBeInTheDocument();
      expect(screen.getByText('K7QX-4M2P')).toBeInTheDocument();
    });

    it('shows the backup code exactly as the backend formatted it', () => {
      render(<PickupCredentialCard pickup={pickup({ credential: { ...credential, code: 'ZZ99-AB12' } })} />);

      expect(screen.getByText('ZZ99-AB12')).toBeInTheDocument();
    });

    it('does not print the QR payload as text anywhere: it is only in the drawn code', () => {
      const { container } = render(<PickupCredentialCard pickup={pickup()} />);

      expect(container.textContent).not.toContain(credential.qrPayload);
      expect(container.textContent).not.toContain('ZP1');
      expect(container.innerHTML).not.toContain(credential.qrPayload);
    });

    it('offers no payment action and no other action', () => {
      render(<PickupCredentialCard pickup={pickup()} />);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('shows nothing for a "ready" result that somehow has no credential', () => {
      render(<PickupCredentialCard pickup={pickup({ credential: null })} />);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.queryByText('Pickup code')).not.toBeInTheDocument();
    });
  });

  describe('when the credential could not be loaded', () => {
    it('says so as an alert and offers a retry, with no QR code and no code', () => {
      const retry = vi.fn();
      render(
        <PickupCredentialCard
          pickup={pickup({ status: 'error', credential: null, error: new TypeError('Failed to fetch'), retry })}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your pickup code");
      expect(screen.getByRole('alert')).toHaveTextContent('Please check your connection and try again.');
      expect(screen.queryByRole('img')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it.each([
      [new ApiError(503, 'unavailable', 'x'), 'Zesto is temporarily unavailable. Please try again in a moment.'],
      [new ApiError(401, 'unauthenticated', 'x'), 'Your session has expired. Please sign in again.'],
      [new ApiError(404, 'not_found', 'x'), "We couldn't find this order."],
      [new ApiError(409, 'conflict', 'x'), "This order isn't ready for pickup any more. Refresh to see where it stands."],
    ])('explains %j', (error, message) => {
      render(<PickupCredentialCard pickup={pickup({ status: 'error', credential: null, error })} />);

      expect(screen.getByRole('alert')).toHaveTextContent(message);
    });
  });
});
