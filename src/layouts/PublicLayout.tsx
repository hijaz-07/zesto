import { IonContent, IonPage } from '@ionic/react';
import type { ReactNode } from 'react';

export interface PublicLayoutProps {
  children: ReactNode;
}

export function PublicLayout({ children }: PublicLayoutProps) {
  return (
    <IonPage>
      <IonContent fullscreen>{children}</IonContent>
    </IonPage>
  );
}
