import { IonApp, setupIonicReact } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { AuthProvider } from '../features/auth/AuthProvider';
import { EnsureProfileLoaded } from '../features/profile/EnsureProfileLoaded';
import { AppRoutes } from './routes';

setupIonicReact();

export function App() {
  return (
    <IonApp>
      <AuthProvider>
        <EnsureProfileLoaded />
        <IonReactRouter>
          <AppRoutes />
        </IonReactRouter>
      </AuthProvider>
    </IonApp>
  );
}
