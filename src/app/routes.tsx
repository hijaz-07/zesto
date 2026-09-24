import { IonRouterOutlet } from '@ionic/react';
import { Route, Routes } from 'react-router-dom';
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
        <Route path="/app/*" element={<CustomerAppLayout />} />
        <Route path="/org/*" element={<OrganizationAppLayout />} />
      </Routes>
    </IonRouterOutlet>
  );
}
