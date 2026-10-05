import { IonContent, IonPage } from '@ionic/react';
import { useMemo } from 'react';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import type { OrganizationId } from '../../domain/types';
import { NotificationsView } from '../../features/notification/NotificationsView';
import type { NotificationScope } from '../../features/notification/types';

export interface OrganizationNotificationsPageProps {
  organizationId: OrganizationId;
}

/**
 * `/org/notifications` — the signed-in member's notifications for this
 * organization (new orders). `organizationId` only names which organization's
 * routes to call: whether the caller may read them is the backend's decision from
 * their own active membership, and a 403 is shown as no access, not retried.
 */
export function OrganizationNotificationsPage({ organizationId }: OrganizationNotificationsPageProps) {
  const scope = useMemo<NotificationScope>(() => ({ kind: 'organization', organizationId }), [organizationId]);

  return (
    <IonPage>
      <OrganizationPageToolbar title="Notifications" />
      <IonContent>
        <NotificationsView scope={scope} />
      </IonContent>
    </IonPage>
  );
}
