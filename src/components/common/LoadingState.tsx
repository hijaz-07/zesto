import { IonSpinner } from '@ionic/react';

export interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2 py-12 text-muted">
      <IonSpinner name="crescent" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
