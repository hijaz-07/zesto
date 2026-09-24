import type { Menu } from '../../domain/types';
import { Card } from '../../components/ui/Card';
import { formatDate, formatTime } from '../../utils/date';

export interface MenuScheduleSummaryProps {
  menu: Menu;
}

export function MenuScheduleSummary({ menu }: MenuScheduleSummaryProps) {
  const fields = [
    { label: 'Menu date', value: formatDate(menu.menuDate) },
    { label: 'Ordering opens', value: formatTime(menu.orderingOpensAt) },
    { label: 'Ordering closes', value: formatTime(menu.orderingClosesAt) },
    { label: 'Pickup window', value: `${formatTime(menu.pickupStartsAt)}–${formatTime(menu.pickupEndsAt)}` },
  ];

  return (
    <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {fields.map((field) => (
        <div key={field.label}>
          <p className="text-xs uppercase tracking-wide text-muted">{field.label}</p>
          <p className="text-sm font-medium text-text">{field.value}</p>
        </div>
      ))}
    </Card>
  );
}
