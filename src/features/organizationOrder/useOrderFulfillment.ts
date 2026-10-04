import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OrganizationId } from '../../domain/types';
import { runFulfillmentAction } from './api';
import { fulfillmentErrorMessage, fulfillmentFailureNeedsRefresh } from './errors';
import type { FulfillmentAction } from './fulfillment';
import type { OrganizationOrderId, OrganizationOrderSummary } from './types';

export interface UseOrderFulfillmentOptions {
  organizationId: OrganizationId;
  /** Called with the backend's row for an order whose action succeeded (including a repeat that changed nothing). */
  onOrderUpdated: (order: OrganizationOrderSummary) => void;
  /**
   * Called when a refused action shows the list on screen is out of date (see
   * `fulfillmentFailureNeedsRefresh`). Re-reads the list and returns the `loadId`
   * of the load that will answer (`useOrganizationOrders`' `refresh`).
   */
  onNeedsRefresh: () => number;
  /** The `loadId` of the rows on screen (`useOrganizationOrders`' `loadId`), which decides when an error has gone stale. */
  listLoadId: number;
}

export interface UseOrderFulfillmentResult {
  /** Orders with an action in flight; their buttons are disabled. */
  pendingOrderIds: ReadonlySet<OrganizationOrderId>;
  /** A message per order whose last action failed, cleared when it is tried again or the list is reloaded (see the hook). */
  errors: Readonly<Record<OrganizationOrderId, string>>;
  /** Asks the backend to move `orderId` along; a no-op while that order already has a request in flight. */
  run: (orderId: OrganizationOrderId, action: FulfillmentAction) => Promise<void>;
}

interface RaisedError {
  message: string;
  /** Stale once the rows on screen come from a load newer than this one. */
  staleAfterLoad: number;
}

/**
 * Runs fulfilment actions (start preparing / mark ready) for the order
 * dashboard. It holds no order data and decides nothing: each call is one
 * request to the backend, which is authoritative for whether the order may move
 * and for who may move it. What it adds is the request's lifecycle on screen —
 * which orders are mid-request, and why one failed.
 *
 * Success hands the backend's own row to `onOrderUpdated`. A refusal that shows
 * the list is stale (409/404/403) also asks for a re-read, so the rows are the
 * server's, not a guess; any other failure leaves everything as it was and the
 * button available to try again. There is one request per order at a time — the
 * guard is a ref, not state, so a second click before React re-renders is
 * still ignored.
 *
 * An error describes the order as it was when the action failed, so it is
 * dropped once the list is read again: any load that lands after it was raised
 * (a Refresh, coming back to the page, a retry or access restored, another outlet
 * filter) replaces it with the server's own view. The one load that does not is
 * the re-read the failure itself asked for — its message says "The list has been
 * refreshed" and has to stay readable next to the refreshed row. That load is
 * identified by the id `onNeedsRefresh` returns, not by timing, so it is the same
 * one whether it succeeds, fails (a 403 that turns out to be real access loss) or
 * was already in flight when the action failed.
 */
export function useOrderFulfillment({
  organizationId,
  onOrderUpdated,
  onNeedsRefresh,
  listLoadId,
}: UseOrderFulfillmentOptions): UseOrderFulfillmentResult {
  const [pendingOrderIds, setPendingOrderIds] = useState<ReadonlySet<OrganizationOrderId>>(() => new Set());
  const [raised, setRaised] = useState<Readonly<Record<OrganizationOrderId, RaisedError>>>({});
  const inFlight = useRef(new Set<OrganizationOrderId>());
  // The latest committed value, for `run`, which outlives the render that created it.
  const listLoadIdRef = useRef(listLoadId);
  useLayoutEffect(() => {
    listLoadIdRef.current = listLoadId;
  }, [listLoadId]);

  const run = useCallback(
    async (orderId: OrganizationOrderId, action: FulfillmentAction) => {
      if (inFlight.current.has(orderId)) {
        return;
      }
      inFlight.current.add(orderId);
      setPendingOrderIds((previous) => new Set(previous).add(orderId));
      setRaised((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== orderId)));

      try {
        onOrderUpdated(await runFulfillmentAction(organizationId, orderId, action));
      } catch (error) {
        // Asking for the re-read first yields the load this error must survive;
        // without one, only a load that starts later than what is on screen now replaces it.
        const staleAfterLoad = fulfillmentFailureNeedsRefresh(error) ? onNeedsRefresh() : listLoadIdRef.current;
        setRaised((previous) => ({
          ...previous,
          [orderId]: { message: fulfillmentErrorMessage(error), staleAfterLoad },
        }));
      } finally {
        inFlight.current.delete(orderId);
        setPendingOrderIds((previous) => {
          const next = new Set(previous);
          next.delete(orderId);
          return next;
        });
      }
    },
    [organizationId, onOrderUpdated, onNeedsRefresh],
  );

  // Derived, not cleared by an effect: an error is simply not reported once a newer load is on screen.
  const errors = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(raised)
          .filter(([, error]) => listLoadId <= error.staleAfterLoad)
          .map(([id, error]) => [id, error.message]),
      ),
    [raised, listLoadId],
  );

  return { pendingOrderIds, errors, run };
}
