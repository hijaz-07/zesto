import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { formatDate } from '../../utils/date';
import { ORDERING_STATE_LABEL, ORDERING_STATE_TONE } from '../menu/badges';
import type { ExploreOutletMenu } from './types';

export interface ExploreMenuCardProps {
  menu: ExploreOutletMenu;
  onClick: () => void;
}

/**
 * One upcoming menu on the outlet detail page. `orderingState` is shown
 * exactly as the backend reported it (see `./types.ts`'s `ExploreOutletMenu`
 * doc comment) — this never recomputes it from the schedule fields.
 */
export function ExploreMenuCard({ menu, onClick }: ExploreMenuCardProps) {
  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        onClick={onClick}
        aria-label={`View ${menu.title}`}
        className="flex w-full flex-col gap-2 p-4 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-text">{menu.title}</h3>
          <Badge tone={ORDERING_STATE_TONE[menu.orderingState]}>
            {ORDERING_STATE_LABEL[menu.orderingState]}
          </Badge>
        </div>
        <p className="text-sm text-muted">{formatDate(menu.menuDate)}</p>
      </button>
    </Card>
  );
}
