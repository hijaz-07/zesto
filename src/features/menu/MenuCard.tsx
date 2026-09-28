import type { BadgeTone } from '../../components/ui/Badge';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatDate, formatTime, getOrderingState, type OrderingState } from '../../utils/date';
import type { Menu, MenuStatus } from './types';

export interface MenuCardProps {
  menu: Menu;
}

const STATUS_TONE: Record<MenuStatus, BadgeTone> = {
  draft: 'warning',
  published: 'success',
  archived: 'neutral',
};

const ORDERING_STATE_LABEL: Record<OrderingState, string> = {
  not_open: 'NOT OPEN',
  open: 'OPEN',
  closed: 'CLOSED',
};

const ORDERING_STATE_TONE: Record<OrderingState, BadgeTone> = {
  not_open: 'neutral',
  open: 'success',
  closed: 'warning',
};

/**
 * One menu in an outlet's menu list. `status` (draft/published/archived) and
 * ordering state (not open/open/closed, derived from the schedule via
 * `getOrderingState`) are two independent badges, deliberately never
 * combined into a single label — a published menu can be "not open" or
 * "closed" just as easily as "open", and collapsing that into one status
 * would misrepresent it.
 *
 * "Manage Menu" is a disabled placeholder: the menu detail/editor page
 * (`/org/menus/{outletId}/{menuId}`) doesn't exist yet. Wiring it up in a
 * later step only needs an `onManage` callback added here and the
 * `disabled` prop dropped — this component and its caller don't need to be
 * restructured.
 */
export function MenuCard({ menu }: MenuCardProps) {
  const orderingState = getOrderingState(menu.orderingOpensAt, menu.orderingClosesAt);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-text">{menu.title}</h3>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge tone={STATUS_TONE[menu.status]}>{menu.status.toUpperCase()}</Badge>
            <Badge tone={ORDERING_STATE_TONE[orderingState]}>{ORDERING_STATE_LABEL[orderingState]}</Badge>
          </div>
        </div>
        <p className="text-sm text-muted">{formatDate(menu.menuDate)}</p>
      </div>

      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Ordering window</dt>
          <dd className="text-text">
            {formatTime(menu.orderingOpensAt)} – {formatTime(menu.orderingClosesAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Pickup window</dt>
          <dd className="text-text">
            {formatTime(menu.pickupStartsAt)} – {formatTime(menu.pickupEndsAt)}
          </dd>
        </div>
      </dl>

      <div className="mt-1 flex flex-col gap-1">
        <Button variant="secondary" disabled aria-label={`Manage ${menu.title}`}>
          Manage Menu
        </Button>
        <p className="text-xs text-muted">Menu management is coming in a future update.</p>
      </div>
    </Card>
  );
}
