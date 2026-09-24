import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import type { DevelopmentStatusItem } from '../types/common';

const statusItems: DevelopmentStatusItem[] = [
  { label: 'Frontend', ready: true },
  { label: 'TypeScript', ready: true },
  { label: 'Ionic', ready: true },
  { label: 'Tailwind', ready: true },
];

export function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-8 p-6 text-center">
      <div>
        <h1 className="text-4xl font-semibold text-text">Zesto</h1>
        <p className="mt-2 text-muted">Know the demand before you cook.</p>
      </div>

      <Card className="w-full">
        <p className="mb-3 text-sm font-medium text-text">Development status</p>
        <div className="flex flex-wrap justify-center gap-2">
          {statusItems.map((item) => (
            <Badge key={item.label} tone={item.ready ? 'success' : 'neutral'}>
              {item.label}
            </Badge>
          ))}
        </div>
      </Card>

      <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        <Button className="w-full sm:w-auto" onClick={() => navigate('/app/menu')}>
          Customer App
        </Button>
        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => navigate('/org/dashboard')}>
          Organization Dashboard
        </Button>
      </div>
    </div>
  );
}
