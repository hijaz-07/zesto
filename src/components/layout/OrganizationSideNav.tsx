import {
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonMenu,
  IonMenuToggle,
} from '@ionic/react';
import {
  analyticsOutline,
  gridOutline,
  receiptOutline,
  restaurantOutline,
  settingsOutline,
} from 'ionicons/icons';

const navItems = [
  { href: '/org/dashboard', label: 'Dashboard', icon: gridOutline },
  { href: '/org/menus', label: 'Menus', icon: restaurantOutline },
  { href: '/org/orders', label: 'Orders', icon: receiptOutline },
  { href: '/org/analytics', label: 'Analytics', icon: analyticsOutline },
  { href: '/org/settings', label: 'Settings', icon: settingsOutline },
];

export function OrganizationSideNav() {
  return (
    <IonMenu contentId="org-main-content">
      <IonContent>
        <IonList className="py-4">
          {navItems.map((item) => (
            <IonMenuToggle key={item.href} autoHide={false}>
              <IonItem routerLink={item.href} routerDirection="none" lines="none" detail={false}>
                <IonIcon icon={item.icon} slot="start" />
                <IonLabel>{item.label}</IonLabel>
              </IonItem>
            </IonMenuToggle>
          ))}
        </IonList>
      </IonContent>
    </IonMenu>
  );
}
