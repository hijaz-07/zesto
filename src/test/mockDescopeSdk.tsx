import type { ReactNode } from 'react';
import { vi } from 'vitest';

/**
 * In-memory stand-in for `@descope/react-sdk`, so unit tests never reach the
 * live Descope service. Use it from a test file with:
 *
 *   vi.mock('@descope/react-sdk', async () => (await import('<path>/test/mockDescopeSdk')).mockDescopeSdkModule);
 *
 * and drive the session by mutating `descopeMock.state` before rendering.
 */

export interface MockDescopeUser {
  userId: string;
  name?: string;
  phone?: string;
  email?: string;
}

export interface MockDescopeState {
  isSessionLoading: boolean;
  isAuthenticated: boolean;
  isUserLoading: boolean;
  user: MockDescopeUser | undefined;
}

const signedOutState: MockDescopeState = {
  isSessionLoading: false,
  isAuthenticated: false,
  isUserLoading: false,
  user: undefined,
};

export const descopeMock = {
  state: { ...signedOutState },
  logout: vi.fn(async () => ({ ok: true })),
  authProviderProps: vi.fn(),
  flowProps: vi.fn(),

  reset() {
    this.state = { ...signedOutState };
    this.logout.mockClear();
    this.authProviderProps.mockClear();
    this.flowProps.mockClear();
  },

  setSessionLoading() {
    this.state = { ...signedOutState, isSessionLoading: true };
  },

  setSignedIn(user: MockDescopeUser = { userId: 'U-test-user', phone: '+910000000000' }) {
    this.state = { isSessionLoading: false, isAuthenticated: true, isUserLoading: false, user };
  },
};

export const mockDescopeSdkModule = {
  AuthProvider: ({ children, ...props }: { children?: ReactNode; projectId: string }) => {
    descopeMock.authProviderProps(props);
    return <>{children}</>;
  },
  useSession: () => ({
    isSessionLoading: descopeMock.state.isSessionLoading,
    isAuthenticated: descopeMock.state.isAuthenticated,
    sessionToken: descopeMock.state.isAuthenticated ? 'mock-session-jwt' : '',
    claims: {},
  }),
  useUser: () => ({
    isUserLoading: descopeMock.state.isUserLoading,
    user: descopeMock.state.user,
  }),
  useDescope: () => ({ logout: descopeMock.logout }),
  Descope: (props: { flowId: string }) => {
    descopeMock.flowProps(props);
    return <div data-testid="descope-flow" data-flow-id={props.flowId} />;
  },
};
