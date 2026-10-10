# Mobile / app-store readiness (audit only)

Capacitor is **not built** and no store work has begun. This lists what engineering must account for
before a Capacitor 8 build can be submitted, and what the repository does and does not have today.
Store requirements change frequently; every dated requirement below must be re-checked against the
current Apple and Google documentation when the work starts.

## What already exists

- Public pages routed and linked from the footer: `/privacy`, `/terms`, `/refund-cancellation`, `/contact`
  (`src/pages/public`). Their business details (support email, operator name) come from
  `VITE_PUBLIC_SUPPORT_EMAIL` / `VITE_PUBLIC_OPERATOR_NAME` at **build time**; unset values render a clearly
  marked placeholder. Policy date constant: `POLICY_LAST_UPDATED`.
- Refund/cancellation policy copy matches the implemented behaviour (7.9).
- A camera path exists (organization pickup QR scanner, `cameraScanning.ts` / `QrScanner.tsx`).
- No push-notification code (no FCM, no service worker); notifications are an in-app, polled inbox. The in-app
  notification centre and the backend notification-event/inbox processing exist; native push is a required future
  subphase (see [Native push notifications](#native-push-notifications-required-mobile--capacitor-subphase)).
- Descope handles authentication (SMS OTP flow).

## Gaps and launch requirements

| Area | What engineering must account for | Today |
| ---- | --------------------------------- | ----- |
| **Account deletion** | Both stores require in-app initiation of account deletion (Apple guideline 5.1.1(v); Google Play account-deletion policy requires an in-app path *and* a web URL). Needs a defined behaviour: delete Descope user, anonymise `users/{id}` and order PII, keep financial/order records required for accounting, cancel/settle open orders first. | **Missing** — no API, UI or policy text |
| **Privacy policy** | Public URL, linked in both store listings and in-app; must describe collection (phone number, name, email, orders, device/notification tokens), processors (Descope, Razorpay, Firebase/Google Cloud), retention, deletion, and children's data stance. | Page exists; content must be reviewed by the business/legal owner |
| **Terms of service / EULA** | Public URL; Apple lets you use the standard EULA or your own. | Page exists |
| **Refund & cancellation policy** | Shown before purchase; consistent with Razorpay's own refund timelines. | Done (7.9) |
| **Support contact** | Real support email/URL required in both stores and in-app. | Env-driven placeholder until set |
| **Store data-safety / privacy declarations** | Apple *App Privacy* nutrition labels and Google Play *Data safety* form: contact info (phone, email, name), user ID, purchase history, device ID/push token (once FCM is added), diagnostics; collected-vs-shared, linked-to-identity, purpose; encryption in transit. Must match Descope/Razorpay/Firebase SDK behaviour. | To compile |
| **Payments policy** | Physical food orders fulfilled outside the app are **not** subject to in-app-purchase rules on Apple (3.1.3(e) goods/services consumed outside the app) or Google Play Billing; payment through Razorpay Checkout is permitted. Confirm wording in the review notes. | OK in principle; document in review notes |
| **Sign-in review access** | Reviewers need a working login without a real phone: provide a Descope **test user** with a fixed OTP and a populated demo organization/outlet in review notes. | To prepare |
| **Notification permissions** | Android 13+ runtime `POST_NOTIFICATIONS`; iOS prompt via APNs. Ask in context (after the first order), never at launch; handle denial; token storage and revocation on logout/deletion. Requires adding FCM (Cloud Messaging), a service worker/Capacitor push plugin and a token-registration API — none exist. | **Not built** (in-app polling only) |
| **Camera / QR permission** | iOS `NSCameraUsageDescription`; Android `CAMERA` permission with runtime request; the QR scanner must fail gracefully when denied. Web `Permissions-Policy` already scopes the camera to the app itself. | Web scanner exists; native strings/permission flow to add |
| **Deep links** | Android App Links (`assetlinks.json`) and iOS Universal Links (`apple-app-site-association`) served from the Hosting domain (needs Hosting config + files, excluded by the current `**/.*` ignore for dotfiles only — `.well-known` must be explicitly allowed). Routes to support: order confirmation, order detail, notifications, `/explore/...`. Descope redirect/OAuth callbacks must work inside the WebView or system browser. | **Not configured** |
| **Session storage** | The Descope web SDK persists tokens in browser storage; in a WebView/native shell use the Descope native/Capacitor-appropriate storage, and clear on logout/deletion. | To decide |
| **Android target SDK** | Google Play requires new apps/updates to target a recent API level (historically the latest or one before it, with an annual August-ish deadline); Capacitor 8's template targets a current level — verify the exact requirement and 16 KB page-size/64-bit requirements at build time. | To verify then |
| **iOS requirements** | Current Xcode/SDK mandated by App Store Connect at submission time; Sign in/privacy manifest (`PrivacyInfo.xcprivacy`) with required-reason API declarations for the app *and* third-party SDKs; ATT is **not** needed if there is no cross-app tracking; Apple developer account, bundle ID, push entitlement and APNs key. | To do |
| **App identity & assets** | Bundle/application ID, icons, splash, screenshots (phone/tablet), listing copy, age rating, category (Food & Drink), content-rating questionnaire. | To do |
| **Network & transport** | HTTPS only (already); production API base must be absolute inside the native shell (the web build uses relative `/api` via Hosting rewrite), and any CORS/CSP consequence must be handled (the API currently sends **no CORS headers** by design — a native WebView on `capacitor://`/`https://localhost` origin would need a deliberate, narrow CORS policy or a native HTTP plugin). | **Design needed** |
| **Offline / lifecycle** | Pickup credential and order status must not be cached in plain storage (current web design deliberately keeps them in memory only); background/foreground refresh of notification count. | Web design OK |
| **Crash & diagnostics** | Crashlytics or equivalent, disclosed in the data-safety forms. | Not present |
| **Regional / compliance** | India: DPDP Act notice and consent wording, data-principal rights (deletion, grievance officer contact); GST invoices if applicable; Razorpay merchant KYC for Live Mode before any production payment. | Business owner |

## Native push notifications (required Mobile / Capacitor subphase)

**NOT started.** Accepted future-roadmap requirement: a required subphase of Mobile / Capacitor that must be
completed before Android/iOS release readiness. Out of scope until staging validation (Checkpoint 4.8) and the
later production gates are done.

**Status**

- In-app notification centre: implemented.
- Backend notification events and inbox processing: implemented and tested.
- Native Android/iOS push delivery: not yet confirmed implemented (no FCM/APNs code in the repo).
- Device token registration, push permissions, delivery, foreground/background handling and notification deep
  links: require implementation and testing.

**Approach**

- Reuse the existing backend notification-event architecture (outbox events → processor → inbox); add push as an
  additional delivery channel, not a second notification system.
- Evaluate Firebase Cloud Messaging for Android and the appropriate APNs integration for iOS (e.g. via FCM's APNs
  support or a Capacitor push plugin; decide when work starts).
- Descope stays the sole authentication provider; no direct Firestore access from the client (device tokens are
  registered through a backend API, validated server-side).

**Requirements**

- [ ] Secure device-token registration (authenticated, server-validated, scoped to the user).
- [ ] Invalid/expired-token cleanup.
- [ ] Notification deduplication (deterministic event IDs, no duplicate push vs inbox).
- [ ] Permission-denied fallback (the in-app inbox keeps working).
- [ ] Deep links to the correct order.
- [ ] Foreground/background handling.
- [ ] Token revocation on logout/account deletion.
- [ ] Tests on real Android and iOS devices (plus unit/emulator tests for the backend parts).

## Sequencing recommendation

1. Account deletion (backend + UI + policy text) — blocks both stores.
2. Real support email/operator name set in the production build; privacy/terms reviewed.
3. Native push (FCM/APNs) is a required subphase before release readiness; until it is built keep the polled inbox
   and omit the notification permission.
4. Decide the native HTTP/CORS approach and deep-link domains; add `.well-known` files to Hosting.
5. Only then add Capacitor, native permissions, and the store declarations.
