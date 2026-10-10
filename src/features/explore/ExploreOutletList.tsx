import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { Button } from '../../components/ui/Button';
import { exploreOutletsErrorMessage } from './errors';
import { ExploreOutletCard } from './ExploreOutletCard';
import { useExploreOutlets } from './useExploreOutlets';

/**
 * The real outlet feed (active outlets with their next published menu), shared by
 * the public `/explore` page and the signed-in customer Menu tab.
 */
export function ExploreOutletList() {
  const { status, outlets, error, retry } = useExploreOutlets();
  const navigate = useNavigate();

  if (status === 'loading') {
    return <LoadingState label="Loading outlets…" />;
  }
  if (status === 'error') {
    return (
      <ErrorState
        title="Couldn't load outlets"
        description={exploreOutletsErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  }
  if (outlets.length === 0) {
    return (
      <EmptyState
        title="No outlets available"
        description="Check back soon for outlets with an upcoming menu."
      />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {outlets.map((outlet) => (
        <ExploreOutletCard
          key={outlet.id}
          outlet={outlet}
          onClick={() => navigate(`/explore/outlets/${outlet.id}`)}
        />
      ))}
    </div>
  );
}
