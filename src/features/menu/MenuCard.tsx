import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatDate, formatTime, getOrderingState } from '../../utils/date';
import { MENU_STATUS_TONE, ORDERING_STATE_LABEL, ORDERING_STATE_TONE } from './badges';
import type { Menu } from './types';

export interface MenuCardProps {
  menu: Menu;
  onManage: () => void;
}

/**
 * One menu in an outlet's menu list. `status` (draft/published/archived) and
 * ordering state (not open/open/closed, derived from the schedule via
 * `getOrderingState`) are two independent badges, deliberately never
 * combined into a single label — a published menu can be "not open" or
 * "closed" just as easily as "open", and collapsing that into one status
 * would misrepresent it.
 */
export function MenuCard({ menu, onManage }: MenuCardProps) {
  const orderingState = getOrderingState(menu.orderingOpensAt, menu.orderingClosesAt);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-text">{menu.title}</h3>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge tone={MENU_STATUS_TONE[menu.status]}>{menu.status.toUpperCase()}</Badge>
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

      <div className="mt-1">
        <Button variant="secondary" onClick={onManage} aria-label={`Manage ${menu.title}`}>
          Manage Menu
        </Button>
      </div>
    </Card>
  );
}
