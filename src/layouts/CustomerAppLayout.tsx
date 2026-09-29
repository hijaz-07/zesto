import { IonRouterOutlet, IonTabs } from '@ionic/react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomerTabBar } from '../components/layout/CustomerTabBar';
import { CustomerCartPage } from '../pages/customer/CustomerCartPage';
import { CustomerMenuPage } from '../pages/customer/CustomerMenuPage';
import { CustomerOrderConfirmationPage } from '../pages/customer/CustomerOrderConfirmationPage';
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
          <Route path="orders/:orderId" element={<CustomerOrderConfirmationPage />} />
          <Route path="profile" element={<CustomerProfilePage />} />
          <Route path="cart" element={<CustomerCartPage />} />
          <Route path="*" element={<Navigate to="menu" replace />} />
        </Routes>
      </IonRouterOutlet>
      <CustomerTabBar />
    </IonTabs>
  );
}
