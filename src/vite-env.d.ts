/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  /** Descope Project ID (public identifier). Validated at startup by `getDescopeProjectId()`. */
  readonly VITE_DESCOPE_PROJECT_ID?: string;
  /** Public support email shown on the public site. Unset → a visible placeholder is rendered. */
  readonly VITE_PUBLIC_SUPPORT_EMAIL?: string;
  /** Owner/operator name shown on legal pages. Unset → a visible placeholder is rendered. */
  readonly VITE_PUBLIC_OPERATOR_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
