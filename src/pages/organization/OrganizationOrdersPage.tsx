import { IonContent, IonPage } from '@ionic/react';
import { useRef, useState, type ReactNode } from 'react';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { Button } from '../../components/ui/Button';
import type { OrganizationId, OrganizationMemberRole, OutletId } from '../../domain/types';
import {
  isOrganizationOrdersForbidden,
  listOrganizationOrdersErrorMessage,
} from '../../features/organizationOrder/errors';
import { canFulfillOrders } from '../../features/organizationOrder/fulfillment';
import { OrderFulfillmentActions } from '../../features/organizationOrder/OrderFulfillmentActions';
import { OrganizationOrdersTable } from '../../features/organizationOrder/OrganizationOrdersTable';
import { useOrderFulfillment } from '../../features/organizationOrder/useOrderFulfillment';
import { useOrganizationOrders } from '../../features/organizationOrder/useOrganizationOrders';
import { useOutlets } from '../../features/outlet/useOutlets';
import { useOnBecameVisible } from '../../hooks/useOnBecameVisible';

export interface OrganizationOrdersPageProps {
  organizationId: OrganizationId;
  /** The caller's membership role (from `GET /organizations`, threaded down via `OrganizationGate` -> `OrganizationAppLayout`). Decides only whether the fulfilment actions are shown — see `canFulfillOrders`. */
  role: OrganizationMemberRole;
}

const ALL_OUTLETS = '';

/**
 * `/org/orders` — the organization's orders, newest first, loaded from the
 * backend a page at a time (`useOrganizationOrders`). It shows what has been
 * ordered and its payment/status, and lets a member move a paid order along:
 * "Start preparing" on a confirmed order, "Mark ready" (after a confirmation)
 * on a preparing one, and "Mark completed" on a picked-up one
 * (`useOrderFulfillment`). A ready order reads "Awaiting pickup": handing it over
 * needs the customer's credential and happens on `/org/pickup`, never from a
 * row. Every action is a request the backend decides — the row shown afterwards
 * is the server's own answer, and a refused action refreshes the list rather than
 * trusting what was on screen. Orders can't be changed in any other way here, and
 * nothing is shown to customers beyond their order's status.
 *
 * The outlet filter is only a request — the backend checks the chosen outlet
 * really belongs to the organization and that the signed-in member may read its
 * orders at all (a 403 is shown as such, not as a retryable failure). Outlets
 * that have since been deactivated stay in the filter: their history is still
 * the organization's.
 *
 * Ionic keeps this page mounted (but hidden) when the person navigates away, so
 * returning to it is not a mount; the visibility hook refreshes the list then,
 * and the Refresh button does the same on demand. Nothing polls.
 */
export function OrganizationOrdersPage({ organizationId, role }: OrganizationOrdersPageProps) {
  const [selectedOutletId, setSelectedOutletId] = useState<OutletId>(ALL_OUTLETS);
  const outletId = selectedOutletId === ALL_OUTLETS ? null : selectedOutletId;
  const {
    status,
    orders,
    error,
    hasMore,
    loadingMore,
    loadMoreError,
    refreshing,
    refreshError,
    loadId,
    retry,
    loadMore,
    refresh,
    replaceOrder,
  } = useOrganizationOrders(organizationId, outletId);
  const { status: outletsStatus, outlets } = useOutlets(organizationId);
  const { pendingOrderIds, errors: actionErrors, run: runAction } = useOrderFulfillment({
    organizationId,
    onOrderUpdated: replaceOrder,
    onNeedsRefresh: refresh,
    listLoadId: loadId,
  });

  const pageRef = useRef<HTMLDivElement>(null);
  useOnBecameVisible(pageRef, refresh);

  let content: ReactNode;
  if (status === 'loading') {
    content = <LoadingState label="Loading orders…" />;
  } else if (status === 'error') {
    content = isOrganizationOrdersForbidden(error) ? (
      <ErrorState
        title="You don't have access to these orders"
        description={listOrganizationOrdersErrorMessage(error)}
      />
    ) : (
      <ErrorState
        title="Couldn't load orders"
        description={listOrganizationOrdersErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (orders.length === 0) {
    content =
      outletId === null ? (
        <EmptyState
          title="No orders yet"
          description="Orders customers place for your menus will appear here."
        />
      ) : (
        <EmptyState
          title="No orders for this outlet"
          description="Choose another outlet, or show all outlets."
          action={
            <Button variant="secondary" onClick={() => setSelectedOutletId(ALL_OUTLETS)}>
              Show all outlets
            </Button>
          }
        />
      );
  } else {
    content = (
      <>
        <OrganizationOrdersTable
          orders={orders}
          renderActions={
            canFulfillOrders(role)
              ? (order) => (
                  <OrderFulfillmentActions
                    order={order}
                    pending={pendingOrderIds.has(order.id)}
                    error={actionErrors[order.id] ?? null}
                    onRun={runAction}
                  />
                )
              : undefined
          }
        />

        {loadMoreError !== null && (
          <p role="alert" className="text-center text-sm text-danger">
            {listOrganizationOrdersErrorMessage(loadMoreError)}
          </p>
        )}

        {hasMore && (
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? 'Loading…' : loadMoreError !== null ? 'Try again' : 'Load more'}
          </Button>
        )}
      </>
    );
  }

  return (
    <IonPage>
      <OrganizationPageToolbar title="Orders" />
      <IonContent>
        <div ref={pageRef} className="flex flex-col gap-4 p-4">
          <PageHeader
            title="Orders"
            subtitle="Pre-orders placed with your outlets, newest first."
            actions={
              <Button variant="secondary" onClick={refresh} disabled={status === 'loading' || refreshing} aria-busy={refreshing}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            }
          />

          <div className="flex max-w-xs flex-col gap-1">
            <label htmlFor="org-orders-outlet-filter" className="text-sm font-medium text-text">
              Outlet
            </label>
            <select
              id="org-orders-outlet-filter"
              value={selectedOutletId}
              disabled={outletsStatus !== 'ready'}
              onChange={(event) => setSelectedOutletId(event.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary disabled:opacity-50"
            >
              <option value={ALL_OUTLETS}>All outlets</option>
              {outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.status === 'inactive' ? `${outlet.name} (inactive)` : outlet.name}
                </option>
              ))}
            </select>
          </div>

          {refreshError !== null && (
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t refresh. Showing the orders loaded earlier. {listOrganizationOrdersErrorMessage(refreshError)}
            </p>
          )}

          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}
