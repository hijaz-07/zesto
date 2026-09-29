import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { formatDate } from '../../utils/date';
import { exploreAddressSummary } from './address';
import type { ExploreOutletSummary } from './types';

export interface ExploreOutletCardProps {
  outlet: ExploreOutletSummary;
  onClick: () => void;
}

/** One outlet in the public Explore feed. Renders only customer-safe fields from `ExploreOutletSummary` — never an organization/outlet ID or any admin field. */
export function ExploreOutletCard({ outlet, onClick }: ExploreOutletCardProps) {
  const summary = exploreAddressSummary(outlet.address);

  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        onClick={onClick}
        aria-label={`View ${outlet.name}`}
        className="flex w-full flex-col gap-2 p-4 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <h3 className="font-medium text-text">{outlet.name}</h3>
        {outlet.description && <p className="text-sm text-muted">{outlet.description}</p>}
        {summary && <p className="text-xs text-muted">{summary}</p>}
        {outlet.nextMenu && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="success">Menu available</Badge>
            <span className="text-xs text-muted">
              {outlet.nextMenu.title} · {formatDate(outlet.nextMenu.menuDate)}
            </span>
          </div>
        )}
      </button>
    </Card>
  );
}
