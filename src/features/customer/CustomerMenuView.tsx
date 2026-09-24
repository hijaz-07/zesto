import { Badge } from '../../components/ui/Badge';
import { PageHeader } from '../../components/common/PageHeader';
import { formatDate, formatTime } from '../../utils/date';
import { tomorrowsMenu } from './data';
import { MenuItemRow } from './MenuItemRow';

export function CustomerMenuView() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title={tomorrowsMenu.title}
        subtitle={`${formatDate(tomorrowsMenu.menuDate)} · Pickup ${formatTime(tomorrowsMenu.pickupStartsAt)}–${formatTime(tomorrowsMenu.pickupEndsAt)}`}
        actions={<Badge tone="success">Ordering open</Badge>}
      />
      <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted">
        Development preview — quantities are illustrative only. No order is placed.
      </p>
      <div className="flex flex-col gap-3">
        {tomorrowsMenu.items.map((item) => (
          <MenuItemRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
