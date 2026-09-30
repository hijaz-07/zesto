import { OperatorName, SupportEmail } from '../../features/public/ConfigValue';
import { LegalList, LegalPage, LegalSection } from '../../features/public/LegalPage';
import { PublicSiteLayout } from '../../features/public/PublicSiteLayout';

export function PrivacyPage() {
  return (
    <PublicSiteLayout>
      <LegalPage
        title="Privacy Policy"
        intro={
          <p>
            This policy explains what information Zesto processes when you use the Zesto website and ordering
            service, why we process it, and the choices you have. Zesto is operated by <OperatorName />.
          </p>
        }
      >
        <LegalSection heading="Information we process">
          <LegalList
            items={[
              <>
                <strong>Sign-in information.</strong> When you sign in, we use an identity provider (Descope) to
                verify you, for example with a one-time code sent to your phone number. We receive an account
                identifier and the contact detail you used to sign in.
              </>,
              <>
                <strong>Profile information.</strong> Basic details associated with your Zesto account, such as
                your name if you provide it.
              </>,
              <>
                <strong>Order information.</strong> The outlet and menu you ordered from, the items and
                quantities, the prices recorded at the time of the order, the order status, and the time of the
                order.
              </>,
              <>
                <strong>Outlet and menu information.</strong> For organizations: outlet details, menus, menu
                items, prices, and ordering and pickup times that you choose to publish.
              </>,
              <>
                <strong>Technical information.</strong> Data needed to operate and secure the service, such as
                request logs, device and browser type, and error diagnostics.
              </>,
            ]}
          />
        </LegalSection>

        <LegalSection heading="Payments">
          <p>
            Online payments are being integrated into the Zesto ordering experience. Payments are processed by a
            third-party payment provider. When you pay, you interact with the provider&apos;s payment interface,
            and the provider handles your card, UPI or other payment credentials.
          </p>
          <p>
            Zesto does not store raw card numbers or UPI credentials. We receive payment status and reference
            information from the provider so we can associate a payment with your order.
          </p>
        </LegalSection>

        <LegalSection heading="How we use information">
          <LegalList
            items={[
              'To create and manage your account and keep it secure.',
              'To place, display and fulfil your pre-orders, and to show outlets the demand for their menus.',
              'To confirm payment status and help resolve payment or order problems.',
              'To operate, maintain, monitor and improve the service, and to prevent misuse and fraud.',
              'To respond to your questions and requests.',
            ]}
          />
        </LegalSection>

        <LegalSection heading="Who can see your information">
          <p>
            An outlet can see the orders placed with it, so that it can prepare and hand over your food. We do
            not sell your personal information.
          </p>
        </LegalSection>

        <LegalSection heading="Service providers and infrastructure">
          <p>
            Zesto relies on third-party providers to run the service, including cloud hosting and database
            infrastructure (Google Firebase), identity and sign-in (Descope), and payment processing. These
            providers process information on our behalf or under their own terms to deliver their services.
          </p>
        </LegalSection>

        <LegalSection heading="Security">
          <p>
            We use reasonable technical and organizational measures to protect information, including access
            controls and server-side validation of privileged operations. No online service can guarantee
            absolute security.
          </p>
        </LegalSection>

        <LegalSection heading="Retention">
          <p>
            We keep information for as long as it is needed to provide the service, keep order and payment
            records, resolve disputes, and meet legal or accounting obligations. When information is no longer
            needed, we delete or de-identify it within a reasonable time.
          </p>
        </LegalSection>

        <LegalSection heading="Your requests">
          <p>
            You can contact us to ask about the information associated with your account, or to request
            correction or deletion, subject to records we need to keep. Write to <SupportEmail />.
          </p>
        </LegalSection>

        <LegalSection heading="Changes to this policy">
          <p>
            We may update this policy as the service changes. The &ldquo;Last updated&rdquo; date above shows
            when it last changed. Continued use of Zesto after an update means you accept the updated policy.
          </p>
        </LegalSection>
      </LegalPage>
    </PublicSiteLayout>
  );
}
