import type { OrganizationMemberRole } from '../../domain/types';
import type { OrderPaymentStatus, OrderStatus } from '../order/types';

/**
 * The fulfilment actions the order dashboard offers: `confirmed` → `preparing`
 * → `ready`. These are requests only — the backend decides whether each is
 * allowed from the order's real state, who may make it, and whether it is paid
 * (functions/src/domain/orderFulfillment.ts); nothing here is authority. What
 * this module decides is just which button, if any, a row on screen offers.
 */
export type FulfillmentAction = 'start-preparing' | 'mark-ready';

export interface FulfillmentActionSpec {
  action: FulfillmentAction;
  label: string;
  /** The button's label while its request is in flight. */
  pendingLabel: string;
  /**
   * Set for an action that cannot be undone, which asks first. (Nothing in this
   * feature moves an order backwards, so every step forward is final; only the
   * last one — telling the customer their food is ready — gets a prompt.)
   */
  confirmation: { question: string; detail: string; confirmLabel: string } | null;
}

const START_PREPARING: FulfillmentActionSpec = {
  action: 'start-preparing',
  label: 'Start preparing',
  pendingLabel: 'Starting…',
  confirmation: null,
};

const MARK_READY: FulfillmentActionSpec = {
  action: 'mark-ready',
  label: 'Mark ready',
  pendingLabel: 'Marking ready…',
  confirmation: {
    question: 'Mark this order ready?',
    detail: "The customer will see it as ready for pickup. This can't be undone.",
    confirmLabel: 'Yes, mark ready',
  },
};

/**
 * The next step an order on screen can be offered, from the status and payment
 * the backend last reported for it: a paid `confirmed` order can be started, a
 * paid `preparing` order can be marked ready, and nothing else is offered — not
 * an order awaiting payment, a cancelled one, or one that is already ready.
 */
export function nextFulfillmentAction(order: {
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}): FulfillmentActionSpec | null {
  if (order.paymentStatus !== 'paid') {
    return null;
  }
  if (order.status === 'confirmed') {
    return START_PREPARING;
  }
  if (order.status === 'preparing') {
    return MARK_READY;
  }
  return null;
}

/**
 * Whether `role` is offered the fulfilment actions: every organization member,
 * staff included, as on the backend (`ORDER_FULFILLMENT_ROLES`) — operating the
 * counter is not configuring the organization, unlike `canManageMenu`. Only
 * what is shown: the backend checks the caller's active membership on every
 * request, so a person who tampers with this still cannot change an order.
 */
export function canFulfillOrders(role: OrganizationMemberRole): boolean {
  return role === 'owner' || role === 'manager' || role === 'staff';
}
