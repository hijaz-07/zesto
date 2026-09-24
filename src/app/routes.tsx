import { IonRouterOutlet } from '@ionic/react';
import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../features/auth/RequireAuth';
import { CustomerAppLayout } from '../layouts/CustomerAppLayout';
import { OrganizationAppLayout } from '../layouts/OrganizationAppLayout';
import { PublicLayout } from '../layouts/PublicLayout';
import { HomePage } from '../pages/HomePage';

export function AppRoutes() {
  return (
    <IonRouterOutlet>
      <Routes>
        <Route
          path="/"
          element={
            <PublicLayout>
              <HomePage />
            </PublicLayout>
          }
        />
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
              <OrganizationAppLayout />
            </RequireAuth>
          }
        />
      </Routes>
    </IonRouterOutlet>
  );
}
