import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrganizationId, OutletId } from '../../domain/types';
import { ApiError } from '../../lib/api/client';
import { redeemPickup, runFulfillmentAction } from './api';
import { completeOrderErrorMessage, redeemPickupErrorMessage } from './errors';
import { normalizePickupInput } from './pickupInput';
import type { OrganizationOrderId, OrganizationOrderSummary } from './types';

/** A successful handover on screen, and where closing the order out has got to. */
export interface PickupResult {
  /** The backend's row for the order: `picked_up`, then `completed` once closed out. */
  order: OrganizationOrderSummary;
  /** "Mark completed" is in flight. */
  completing: boolean;
  /** Why the last "Mark completed" failed, if it did. */
  completionError: string | null;
}

interface PickupState {
  submitting: boolean;
  error: string | null;
  result: PickupResult | null;
}

const INITIAL: PickupState = { submitting: false, error: null, result: null };

export interface UsePickupRedeemResult {
  /** A redemption is in flight; the form is disabled and nothing else can be submitted. */
  submitting: boolean;
  /** Why the last attempt did not hand an order over. Cleared when the next attempt starts. */
  error: string | null;
  /** The order just handed over — only ever set by a backend answer saying `picked_up`. */
  result: PickupResult | null;
  /**
   * Redeems what was typed, pasted or scanned. A no-op while another attempt is
   * in flight. Input that plainly is not a pickup code is refused here without a
   * request; everything else is the backend's decision.
   */
  submit: (raw: string, outletId: OutletId | null) => Promise<void>;
  /** Closes out the order just handed over (`picked_up` → `completed`). A no-op while that is in flight. */
  complete: (orderId: OrganizationOrderId) => Promise<void>;
  /** Clears the result and any error, ready for the next customer. */
  dismiss: () => void;
}

/**
 * Drives `/org/pickup`: redeeming a pickup credential, then closing the order
 * out. It decides nothing — each call is one request to the backend, which finds
 * the order from the credential and is authoritative for whether it may be handed
 * over, who may hand it over, and whether it is paid. What this adds is the
 * request's lifecycle on screen.
 *
 * The credential is a SECRET and is only ever an argument to `submit`: it is
 * never put in state, a ref, storage or a URL, never logged, and is gone the
 * moment the request has been sent (the page also clears its input at that
 * point). After ANY attempt, success or failure, nothing of it remains.
 *
 * - One redemption at a time. The guard is a ref, not state, so a second press
 *   or scan before React re-renders is still ignored — a double scan can never
 *   send two requests.
 * - Starting an attempt clears the previous result and error first, so a failed
 *   attempt can never leave an earlier success on screen looking like its
 *   outcome; success is shown only from the backend's own row, and only if that
 *   row says `picked_up`.
 * - After a refusal nothing is assumed: the order is whatever the backend says,
 *   and the message says why (see `redeemPickupErrorMessage`, including the case
 *   where it is not known whether the pickup was recorded).
 */
export function usePickupRedeem(organizationId: OrganizationId): UsePickupRedeemResult {
  const [state, setState] = useState<PickupState>(INITIAL);
  const redeeming = useRef(false);
  const completing = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((next: (current: PickupState) => PickupState) => {
    if (mounted.current) {
      setState(next);
    }
  }, []);

  const submit = useCallback(
    async (raw: string, outletId: OutletId | null) => {
      if (redeeming.current) {
        return;
      }
      const input = normalizePickupInput(raw);
      if (!input.ok) {
        update(() => ({ submitting: false, error: input.message, result: null }));
        return;
      }

      redeeming.current = true;
      update(() => ({ submitting: true, error: null, result: null }));
      try {
        const order = await redeemPickup(organizationId, {
          credential: input.credential,
          outletId: outletId ?? undefined,
        });
        update(() => ({ submitting: false, error: null, result: { order, completing: false, completionError: null } }));
      } catch (error) {
        update(() => ({ submitting: false, error: redeemPickupErrorMessage(error), result: null }));
      } finally {
        redeeming.current = false;
      }
    },
    [organizationId, update],
  );

  const complete = useCallback(
    async (orderId: OrganizationOrderId) => {
      if (completing.current) {
        return;
      }
      completing.current = true;
      /** Applies `next` only to the result still on screen for this order. */
      const onResult = (next: (result: PickupResult) => PickupResult) =>
        update((current) =>
          current.result && current.result.order.id === orderId ? { ...current, result: next(current.result) } : current,
        );

      onResult((result) => ({ ...result, completing: true, completionError: null }));
      try {
        const order = await runFulfillmentAction(organizationId, orderId, 'complete');
        if (order.status !== 'completed') {
          throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
        }
        onResult(() => ({ order, completing: false, completionError: null }));
      } catch (error) {
        onResult((result) => ({ ...result, completing: false, completionError: completeOrderErrorMessage(error) }));
      } finally {
        completing.current = false;
      }
    },
    [organizationId, update],
  );

  const dismiss = useCallback(() => {
    // Not while an attempt is in flight: its answer would land on a cleared screen.
    if (!redeeming.current && !completing.current) {
      update(() => INITIAL);
    }
  }, [update]);

  return { submitting: state.submitting, error: state.error, result: state.result, submit, complete, dismiss };
}
