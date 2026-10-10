import { IonRouterOutlet, IonSplitPane } from '@ionic/react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { OrganizationId, OrganizationMemberRole } from '../domain/types';
import { OrganizationSideNav } from '../components/layout/OrganizationSideNav';
import { NotificationProvider } from '../features/notification/NotificationProvider';
import { OrganizationAnalyticsPage } from '../pages/organization/OrganizationAnalyticsPage';
import { OrganizationCreateMenuPage } from '../pages/organization/OrganizationCreateMenuPage';
import { OrganizationDashboardPage } from '../pages/organization/OrganizationDashboardPage';
import { OrganizationMenuEditorPage } from '../pages/organization/OrganizationMenuEditorPage';
import { OrganizationMenusPage } from '../pages/organization/OrganizationMenusPage';
import { OrganizationNotificationsPage } from '../pages/organization/OrganizationNotificationsPage';
import { OrganizationOrdersPage } from '../pages/organization/OrganizationOrdersPage';
import { OrganizationOutletMenusPage } from '../pages/organization/OrganizationOutletMenusPage';
import { OrganizationOutletsPage } from '../pages/organization/OrganizationOutletsPage';
import { OrganizationPickupPage } from '../pages/organization/OrganizationPickupPage';
import { OrganizationSettingsPage } from '../pages/organization/OrganizationSettingsPage';

export interface OrganizationAppLayoutProps {
  organizationId: OrganizationId;
  /** The caller's membership role in `organizationId`, from `GET /organizations` (see `OrganizationGate`). Threaded only to the routes that currently need it for mutation-control gating — not a global role context. */
  role: OrganizationMemberRole;
}

/**
 * Desktop-first organization shell: a persistent side menu over a routed outlet.
 * It mounts the shell's one `NotificationProvider` (this organization's unread count).
 */
export function OrganizationAppLayout({ organizationId, role }: OrganizationAppLayoutProps) {
  return (
    <NotificationProvider scope={{ kind: 'organization', organizationId }}>
      <IonSplitPane contentId="org-main-content" when="md">
        <OrganizationSideNav />
        <IonRouterOutlet id="org-main-content">
          <Routes>
            <Route path="dashboard" element={<OrganizationDashboardPage organizationId={organizationId} />} />
            <Route path="menus" element={<OrganizationMenusPage organizationId={organizationId} />} />
            <Route
              path="menus/:outletId"
              element={<OrganizationOutletMenusPage organizationId={organizationId} />}
            />
            <Route
              path="menus/:outletId/new"
              element={<OrganizationCreateMenuPage organizationId={organizationId} />}
            />
            <Route
              path="menus/:outletId/:menuId"
              element={<OrganizationMenuEditorPage organizationId={organizationId} role={role} />}
            />
            <Route path="outlets" element={<OrganizationOutletsPage organizationId={organizationId} />} />
            <Route path="orders" element={<OrganizationOrdersPage organizationId={organizationId} role={role} />} />
            <Route path="pickup" element={<OrganizationPickupPage organizationId={organizationId} role={role} />} />
            <Route path="notifications" element={<OrganizationNotificationsPage organizationId={organizationId} />} />
            <Route path="analytics" element={<OrganizationAnalyticsPage />} />
            <Route path="settings" element={<OrganizationSettingsPage />} />
            <Route path="*" element={<Navigate to="dashboard" replace />} />
          </Routes>
        </IonRouterOutlet>
      </IonSplitPane>
    </NotificationProvider>
  );
}
