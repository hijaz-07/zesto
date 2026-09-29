import { useCallback, useRef, useState } from 'react';
import { createOrder as createOrderRequest, type CreateOrderRequestItem } from './api';
import { generateIdempotencyKey } from './idempotencyKey';
import type { Order } from './types';

export interface CreateOrderSubmission {
  outletId: string;
  menuId: string;
  items: CreateOrderRequestItem[];
}

export type CreateOrderStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface UseCreateOrderResult {
  status: CreateOrderStatus;
  order: Order | null;
  error: unknown;
  /** Submits (or retries) this attempt. Rejects with the same error `error` is set to; callers that don't need the rejection can ignore it and read `status`/`error` instead. */
  submit: (submission: CreateOrderSubmission) => Promise<Order>;
  /** Starts a genuinely new attempt — a fresh idempotency key will be generated on the next `submit`. */
  reset: () => void;
}

/**
 * Submits a cart for order creation. The idempotency key for one logical
 * submission attempt is generated once, lazily, on the first `submit` call,
 * and reused for every subsequent call to the same hook instance — so
 * clicking "Place Order" more than once, or retrying after a network
 * failure, can never create more than one order (see
 * functions/src/domain/orders.ts's idempotency design). Call `reset()` when
 * the customer abandons this attempt and starts a new one (e.g. they went
 * back to the cart and changed it), so the next `submit` gets a fresh key.
 */
export function useCreateOrder(): UseCreateOrderResult {
  const [status, setStatus] = useState<CreateOrderStatus>('idle');
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<unknown>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const submit = useCallback(async (submission: CreateOrderSubmission): Promise<Order> => {
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = generateIdempotencyKey();
    }

    setStatus('submitting');
    setError(null);
    try {
      const response = await createOrderRequest({ ...submission, idempotencyKey: idempotencyKeyRef.current });
      setOrder(response.order);
      setStatus('success');
      return response.order;
    } catch (err) {
      setError(err);
      setStatus('error');
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    idempotencyKeyRef.current = null;
    setStatus('idle');
    setOrder(null);
    setError(null);
  }, []);

  return { status, order, error, submit, reset };
}
