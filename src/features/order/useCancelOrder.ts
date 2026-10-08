import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelOrder, getOrder } from './api';
import { cancelOrderErrorMessage, cancellationUnavailableMessage } from './errors';
import { ApiError } from '../../lib/api/client';
import type { CustomerCancellationReason, Order, OrderId } from './types';

export type CancelOrderOutcome =
  /** The order is now cancelled (by this request, or already was). */
  | 'cancelled'
  /** The order could not be cancelled; the screen was told why and the order re-read. */
  | 'refused'
  /** The request did not get an answer worth acting on; the customer may try again. */
  | 'failed'
  /** Another request is still in flight, or there is no order: nothing was sent. */
  | 'ignored';

export interface UseCancelOrderResult {
  /** A cancellation request is in flight. */
  submitting: boolean;
  /** Why the last attempt did not cancel the order, in customer words. Cleared when a new attempt starts. */
  errorMessage: string | null;
  /** The newest copy of the order this hook has seen from the server (the cancellation's own response, or a re-read after a refusal). */
  order: Order | null;
  /**
   * Cancels the order, once. A second call while one is in flight is ignored, so
   * a double-click or a repeated key press can never send two requests. Nothing
   * is retried automatically: a failure is reported and the customer decides.
   */
  cancel: (reason?: CustomerCancellationReason) => Promise<CancelOrderOutcome>;
  /** Forgets the last error (the customer dismissed the dialog). */
  clearError: () => void;
}

/**
 * Drives the customer's cancellation of one order: sends `POST /orders/{id}/cancel`
 * with the reason (if any) and nothing else, and reports what the server decided.
 * The server is the only authority: this never decides eligibility, a refund or
 * an amount, and the screen shows the cancelled order only from the server's own
 * response.
 *
 * A `409` means the cancellation lost a race or the order moved on (preparation
 * started, the deadline passed): the order is re-read so the screen shows where
 * it really stands, and the customer is told why in plain words. If the re-read
 * shows the order is in fact cancelled (cancelled in another tab), that is
 * success, not an error.
 */
export function useCancelOrder(orderId: OrderId | undefined): UseCancelOrderResult {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  // A ref, not state: a second click lands before the state update re-renders.
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const cancel = useCallback(
    async (reason?: CustomerCancellationReason): Promise<CancelOrderOutcome> => {
      if (!orderId || inFlight.current) {
        return 'ignored';
      }
      inFlight.current = true;
      setSubmitting(true);
      setErrorMessage(null);

      const settle = (next: { order?: Order; errorMessage?: string }) => {
        if (!mounted.current) {
          return;
        }
        if (next.order) {
          setOrder(next.order);
        }
        setErrorMessage(next.errorMessage ?? null);
      };

      try {
        const response = await cancelOrder(orderId, reason);
        settle({ order: response.order });
        return 'cancelled';
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 409) {
          // Lost a race or past the point of cancelling: show where the order really is.
          try {
            const { order: latest } = await getOrder(orderId);
            if (latest.status === 'cancelled') {
              settle({ order: latest });
              return 'cancelled';
            }
            settle({
              order: latest,
              errorMessage: cancellationUnavailableMessage(latest) ?? cancelOrderErrorMessage(error),
            });
          } catch {
            settle({ errorMessage: cancelOrderErrorMessage(error) });
          }
          return 'refused';
        }
        settle({ errorMessage: cancelOrderErrorMessage(error) });
        return 'failed';
      } finally {
        inFlight.current = false;
        if (mounted.current) {
          setSubmitting(false);
        }
      }
    },
    [orderId],
  );

  const clearError = useCallback(() => setErrorMessage(null), []);

  return { submitting, errorMessage, order, cancel, clearError };
}
