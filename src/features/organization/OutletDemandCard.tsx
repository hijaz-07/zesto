import { Link } from 'react-router-dom';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { OrganizationId, Outlet, OutletId } from '../../domain/types';
import { businessToday, formatDate, formatTime, getOrderingState } from '../../utils/date';
import { ORDERING_STATE_LABEL, ORDERING_STATE_TONE } from '../menu/badges';
import { menuErrorMessage } from '../menu/errors';
import type { Menu } from '../menu/types';
import { useMenus } from '../menu/useMenus';
import { DemandOverview } from './DemandOverview';
import { selectNextMenu } from './nextMenu';
import { useMenuDemand } from './useMenuDemand';

export interface OutletDemandCardProps {
  organizationId: OrganizationId;
  outlet: Outlet;
}

/** One outlet's next menu and its real demand (paid, not-cancelled orders), from the server. */
export function OutletDemandCard({ organizationId, outlet }: OutletDemandCardProps) {
  const menus = useMenus(organizationId, outlet.id);

  let body;
  if (menus.status === 'loading') {
    body = <LoadingState label="Loading menus…" />;
  } else if (menus.status === 'error') {
    body = (
      <ErrorState
        title="Couldn't load menus"
        description={menuErrorMessage(menus.error)}
        action={<Button onClick={menus.retry}>Try again</Button>}
      />
    );
  } else {
    const menu = selectNextMenu(menus.menus, businessToday());
    body = menu ? (
      <MenuDemandSection organizationId={organizationId} outletId={outlet.id} menu={menu} />
    ) : (
      <p className="text-sm text-muted">
        No upcoming published menu for this outlet.{' '}
        <Link to={`/org/menus/${outlet.id}`} className="text-primary underline">
          Go to Menus
        </Link>
      </p>
    );
  }

  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold text-text">{outlet.name}</h2>
      {body}
    </Card>
  );
}

interface MenuDemandSectionProps {
  organizationId: OrganizationId;
  outletId: OutletId;
  menu: Menu;
}

function MenuDemandSection({ organizationId, outletId, menu }: MenuDemandSectionProps) {
  const demand = useMenuDemand(organizationId, outletId, menu.id);
  const orderingState = getOrderingState(menu.orderingOpensAt, menu.orderingClosesAt);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link to={`/org/menus/${outletId}/${menu.id}`} className="font-medium text-text underline">
            {menu.title}
          </Link>
          <p className="text-sm text-muted">
            {formatDate(menu.menuDate)} · Pickup {formatTime(menu.pickupStartsAt)}–{formatTime(menu.pickupEndsAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={ORDERING_STATE_TONE[orderingState]}>{ORDERING_STATE_LABEL[orderingState]}</Badge>
          <Button variant="secondary" onClick={demand.refresh} disabled={demand.status === 'loading'}>
            Refresh
          </Button>
        </div>
      </div>

      {demand.status === 'loading' && <LoadingState label="Loading demand…" />}
      {demand.status === 'error' && (
        <ErrorState
          title="Couldn't load demand"
          description={menuErrorMessage(demand.error)}
          action={<Button onClick={demand.refresh}>Try again</Button>}
        />
      )}
      {demand.status === 'ready' && (
        <>
          <p className="text-sm text-text">
            <span className="font-medium">{demand.demand.paidOrders}</span> paid{' '}
            {demand.demand.paidOrders === 1 ? 'order' : 'orders'} ·{' '}
            <span className="font-medium">{demand.demand.totalPortions}</span>{' '}
            {demand.demand.totalPortions === 1 ? 'portion' : 'portions'}
          </p>
          {demand.demand.paidOrders === 0 && <p className="text-sm text-muted">No paid orders yet.</p>}
          {demand.demand.items.length > 0 && (
            <DemandOverview
              lines={demand.demand.items.map((item) => ({
                menuItemId: item.itemId,
                menuItemName: item.name,
                totalQuantity: item.portions,
              }))}
            />
          )}
          <p className="text-xs text-muted">
            Paid orders only — unpaid and cancelled orders are not counted. Updated{' '}
            {formatTime(demand.demand.computedAt)}.
          </p>
        </>
      )}
    </div>
  );
}
