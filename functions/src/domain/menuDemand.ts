import type {Firestore} from "firebase-admin/firestore";
import type {Menu} from "./menus";
import {listMenuItemsForMenu, type MenuItemResponse} from "./menuItems";
import {parseOrder, type Order, type OrderStatus} from "./orders";

/**
 * Statuses that count as demand: paid and not cancelled. `pending_payment` is
 * never paid and `cancelled` is withdrawn demand, so neither is in the set.
 */
const DEMAND_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "confirmed", "preparing", "ready", "picked_up", "completed",
]);

/** One menu item's demand. */
export interface MenuItemDemand {
  itemId: string;
  name: string;
  portions: number;
}

/** `GET .../menus/{menuId}/demand`'s response body. */
export interface MenuDemandResponse {
  menuId: string;
  paidOrders: number;
  totalPortions: number;
  items: MenuItemDemand[];
  computedAt: string;
}

/**
 * Whether an order counts toward its menu's demand.
 *
 * @param {Order} order The order.
 * @return {boolean} True when it is paid and not cancelled.
 */
export function countsAsDemand(order: Order): boolean {
  return order.paymentStatus === "paid" && DEMAND_STATUSES.has(order.status);
}

/**
 * Adds up demand from order snapshots — never from the live menu, so renaming,
 * repricing or deleting an item never changes demand already recorded. Every
 * enabled item is listed (0 when nobody ordered it), in menu display order; an
 * item that has demand but is now disabled or deleted is listed too, after them,
 * under its name at order time.
 *
 * @param {ReadonlyArray<MenuItemResponse>} menuItems The menu's current items.
 * @param {ReadonlyArray<Order>} orders The menu's orders, of any status.
 * @return {{paidOrders: number, totalPortions: number, items: MenuItemDemand[]}}
 *   The aggregate.
 */
export function aggregateMenuDemand(
  menuItems: ReadonlyArray<MenuItemResponse>,
  orders: ReadonlyArray<Order>,
): {paidOrders: number; totalPortions: number; items: MenuItemDemand[]} {
  const portionsByItem = new Map<string, number>();
  const orderedNames = new Map<string, string>();
  let paidOrders = 0;
  let totalPortions = 0;
  for (const order of orders) {
    if (!countsAsDemand(order)) {
      continue;
    }
    paidOrders += 1;
    for (const line of order.items) {
      portionsByItem.set(line.itemId, (portionsByItem.get(line.itemId) ?? 0) + line.quantity);
      orderedNames.set(line.itemId, line.name);
      totalPortions += line.quantity;
    }
  }

  const items: MenuItemDemand[] = [];
  const listed = new Set<string>();
  for (const item of menuItems) {
    const portions = portionsByItem.get(item.id) ?? 0;
    if (item.enabled || portions > 0) {
      items.push({itemId: item.id, name: item.name, portions});
      listed.add(item.id);
    }
  }
  for (const [itemId, portions] of portionsByItem) {
    if (!listed.has(itemId)) {
      items.push({itemId, name: orderedNames.get(itemId) ?? itemId, portions});
    }
  }
  return {paidOrders, totalPortions, items};
}

/**
 * Reads one menu's items and paid orders and returns its demand. Read-only.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Menu} menu The menu, already resolved inside the caller's
 *   organization and outlet.
 * @param {Date} [now] Injected clock, for tests.
 * @return {Promise<MenuDemandResponse>} The menu's demand.
 */
export async function getMenuDemand(
  db: Firestore,
  menu: Menu,
  now: Date = new Date(),
): Promise<MenuDemandResponse> {
  const ordersSnapshot = await db
    .collection("organizations").doc(menu.organizationId)
    .collection("outlets").doc(menu.outletId)
    .collection("menus").doc(menu.id)
    .collection("orders")
    .where("paymentStatus", "==", "paid")
    .get();
  const orders = ordersSnapshot.docs.map((doc) =>
    parseOrder(doc.data(), doc.id, menu.organizationId, menu.outletId, menu.id));
  const menuItems = await listMenuItemsForMenu(db, menu.organizationId, menu.outletId, menu.id);
  return {menuId: menu.id, ...aggregateMenuDemand(menuItems, orders), computedAt: now.toISOString()};
}
