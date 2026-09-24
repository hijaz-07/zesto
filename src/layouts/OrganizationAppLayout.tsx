import { IonRouterOutlet, IonSplitPane } from '@ionic/react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { OrganizationSideNav } from '../components/layout/OrganizationSideNav';
import { OrganizationAnalyticsPage } from '../pages/organization/OrganizationAnalyticsPage';
import { OrganizationDashboardPage } from '../pages/organization/OrganizationDashboardPage';
import { OrganizationMenusPage } from '../pages/organization/OrganizationMenusPage';
import { OrganizationOrdersPage } from '../pages/organization/OrganizationOrdersPage';
import { OrganizationSettingsPage } from '../pages/organization/OrganizationSettingsPage';

/** Desktop-first organization shell: a persistent side menu over a routed outlet. */
export function OrganizationAppLayout() {
  return (
    <IonSplitPane contentId="org-main-content" when="md">
      <OrganizationSideNav />
      <IonRouterOutlet id="org-main-content">
        <Routes>
          <Route path="dashboard" element={<OrganizationDashboardPage />} />
          <Route path="menus" element={<OrganizationMenusPage />} />
          <Route path="orders" element={<OrganizationOrdersPage />} />
          <Route path="analytics" element={<OrganizationAnalyticsPage />} />
          <Route path="settings" element={<OrganizationSettingsPage />} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </IonRouterOutlet>
    </IonSplitPane>
  );
}
