import { apiFetch } from '../../lib/api/client';
import type {
  ExploreMenuDetail,
  ExploreMenuId,
  ExploreOutlet,
  ExploreOutletId,
  ExploreOutletMenu,
  ExploreOutletSummary,
} from './types';

/**
 * The public, unauthenticated `/explore` customer-discovery API
 * (functions/src/routes/explore.ts). These calls go through the same
 * `apiFetch` every other feature uses — no separate "public" client and no
 * manually constructed `Authorization` header: `apiFetch` already omits
 * that header whenever there is no Descope session to send (see
 * `src/lib/api/client.ts`'s `currentSessionToken`), which is exactly the
 * unauthenticated behavior these endpoints need. When a session does
 * exist (e.g. a signed-in organization owner browsing as a customer),
 * `apiFetch` still attaches it — harmless, since the backend never
 * inspects it for these routes.
 */

interface GetExploreOutletsResponse {
  outlets: ExploreOutletSummary[];
}

interface GetExploreOutletResponse {
  outlet: ExploreOutlet;
  menus: ExploreOutletMenu[];
}

interface GetExploreMenuResponse {
  outlet: ExploreOutlet;
  menu: ExploreMenuDetail;
}

/** The default customer discovery feed: active outlets with an upcoming customer-visible published menu. */
export function getExploreOutlets(): Promise<GetExploreOutletsResponse> {
  return apiFetch<GetExploreOutletsResponse>('/explore/outlets');
}

/** One active outlet and its upcoming customer-visible menus (no items). */
export function getExploreOutlet(outletId: ExploreOutletId): Promise<GetExploreOutletResponse> {
  return apiFetch<GetExploreOutletResponse>(`/explore/outlets/${outletId}`);
}

/** One customer-safe published menu and its enabled items. */
export function getExploreMenu(
  outletId: ExploreOutletId,
  menuId: ExploreMenuId,
): Promise<GetExploreMenuResponse> {
  return apiFetch<GetExploreMenuResponse>(`/explore/outlets/${outletId}/menus/${menuId}`);
}
