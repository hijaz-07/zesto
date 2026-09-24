import { IonRouterOutlet, IonTabs } from '@ionic/react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomerTabBar } from '../components/layout/CustomerTabBar';
import { CustomerMenuPage } from '../pages/customer/CustomerMenuPage';
import { CustomerOrdersPage } from '../pages/customer/CustomerOrdersPage';
import { CustomerProfilePage } from '../pages/customer/CustomerProfilePage';

/** Mobile-first customer shell: bottom tab navigation over a routed outlet. */
export function CustomerAppLayout() {
  return (
    <IonTabs>
      <IonRouterOutlet>
        <Routes>
          <Route path="menu" element={<CustomerMenuPage />} />
          <Route path="orders" element={<CustomerOrdersPage />} />
          <Route path="profile" element={<CustomerProfilePage />} />
          <Route path="*" element={<Navigate to="menu" replace />} />
        </Routes>
      </IonRouterOutlet>
      <CustomerTabBar />
    </IonTabs>
  );
}
