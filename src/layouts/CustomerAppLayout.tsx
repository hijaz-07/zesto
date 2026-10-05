import { IonRouterOutlet, IonTabs } from '@ionic/react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomerTabBar } from '../components/layout/CustomerTabBar';
import { NotificationProvider } from '../features/notification/NotificationProvider';
import type { NotificationScope } from '../features/notification/types';
import { CustomerCartPage } from '../pages/customer/CustomerCartPage';
import { CustomerMenuPage } from '../pages/customer/CustomerMenuPage';
import { CustomerNotificationsPage } from '../pages/customer/CustomerNotificationsPage';
import { CustomerOrderConfirmationPage } from '../pages/customer/CustomerOrderConfirmationPage';
import { CustomerOrdersPage } from '../pages/customer/CustomerOrdersPage';
import { CustomerProfilePage } from '../pages/customer/CustomerProfilePage';

const CUSTOMER_NOTIFICATIONS: NotificationScope = { kind: 'customer' };

/**
 * Mobile-first customer shell: bottom tab navigation over a routed outlet. It
 * mounts the shell's one `NotificationProvider` (the customer's unread count).
 */
export function CustomerAppLayout() {
  return (
    <NotificationProvider scope={CUSTOMER_NOTIFICATIONS}>
      <IonTabs>
        <IonRouterOutlet>
          <Routes>
            <Route path="menu" element={<CustomerMenuPage />} />
            <Route path="orders" element={<CustomerOrdersPage />} />
            <Route path="orders/:orderId" element={<CustomerOrderConfirmationPage />} />
            <Route path="notifications" element={<CustomerNotificationsPage />} />
            <Route path="profile" element={<CustomerProfilePage />} />
            <Route path="cart" element={<CustomerCartPage />} />
            <Route path="*" element={<Navigate to="menu" replace />} />
          </Routes>
        </IonRouterOutlet>
        <CustomerTabBar />
      </IonTabs>
    </NotificationProvider>
  );
}
