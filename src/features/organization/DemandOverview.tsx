import type { DemandLine } from '../../domain/types';
import { Card } from '../../components/ui/Card';

export interface DemandOverviewProps {
  lines: DemandLine[];
}

export function DemandOverview({ lines }: DemandOverviewProps) {
  const total = lines.reduce((sum, line) => sum + line.totalQuantity, 0);
  const max = Math.max(...lines.map((line) => line.totalQuantity), 1);

  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm font-medium text-text">Demand overview</p>
        <p className="text-sm text-muted">{total} portions total</p>
      </div>
      <div className="flex flex-col gap-2">
        {lines.map((line) => (
          <div key={line.menuItemId} className="flex items-center gap-3">
            <span className="w-32 shrink-0 truncate text-sm text-text">{line.menuItemName}</span>
            <div className="h-2 flex-1 rounded-full bg-background">
              <div
                className="h-2 rounded-full bg-primary"
                style={{ width: `${(line.totalQuantity / max) * 100}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-sm font-medium text-text">
              {line.totalQuantity}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
