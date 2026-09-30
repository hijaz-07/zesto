import { IonRouterOutlet } from '@ionic/react';
import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../features/auth/RequireAuth';
import { CustomerAppLayout } from '../layouts/CustomerAppLayout';
import { OrganizationGate } from '../layouts/OrganizationGate';
import { PublicLayout } from '../layouts/PublicLayout';
import { HomePage } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { ExploreMenuDetailPage } from '../pages/customer/ExploreMenuDetailPage';
import { ExploreOutletPage } from '../pages/customer/ExploreOutletPage';
import { ExplorePage } from '../pages/customer/ExplorePage';
import { ContactPage } from '../pages/public/ContactPage';
import { PrivacyPage } from '../pages/public/PrivacyPage';
import { RefundCancellationPage } from '../pages/public/RefundCancellationPage';
import { TermsPage } from '../pages/public/TermsPage';

export function AppRoutes() {
  return (
    <IonRouterOutlet>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/refund-cancellation" element={<RefundCancellationPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route
          path="/login"
          element={
            <PublicLayout>
              <LoginPage />
            </PublicLayout>
          }
        />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/explore/outlets/:outletId" element={<ExploreOutletPage />} />
        <Route path="/explore/outlets/:outletId/menus/:menuId" element={<ExploreMenuDetailPage />} />
        <Route
          path="/app/*"
          element={
            <RequireAuth>
              <CustomerAppLayout />
            </RequireAuth>
          }
        />
        <Route
          path="/org/*"
          element={
            <RequireAuth>
              <OrganizationGate />
            </RequireAuth>
          }
        />
      </Routes>
    </IonRouterOutlet>
  );
}
