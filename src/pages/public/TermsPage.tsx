import { SupportEmail } from '../../features/public/ConfigValue';
import { LegalList, LegalPage, LegalSection } from '../../features/public/LegalPage';
import { PublicSiteLayout } from '../../features/public/PublicSiteLayout';

export function TermsPage() {
  return (
    <PublicSiteLayout>
      <LegalPage
        title="Terms of Use"
        intro={
          <p>
            These terms govern your use of the Zesto website and ordering service (&ldquo;Zesto&rdquo;). Please
            read them before using Zesto.
          </p>
        }
      >
        <LegalSection heading="Acceptance of terms">
          <p>By accessing or using Zesto you agree to these terms. If you do not agree, please do not use Zesto.</p>
        </LegalSection>

        <LegalSection heading="Eligibility">
          <p>
            You must be able to form a binding agreement to use Zesto. If you use Zesto on behalf of an
            organization, you confirm you are authorized to do so.
          </p>
        </LegalSection>

        <LegalSection heading="Accounts">
          <p>
            You are responsible for the activity on your account and for keeping your sign-in details secure.
            Give accurate information, and tell us if you suspect unauthorized use.
          </p>
        </LegalSection>

        <LegalSection heading="Browsing menus and placing pre-orders">
          <p>
            Outlets publish menus for upcoming days, with prices, an ordering deadline and a pickup window. You
            can browse published menus without an account. To place a pre-order you choose items and
            quantities and review the order before submitting it. Orders can only be placed while ordering is
            open for that menu.
          </p>
          <p>
            Zesto records the demand you place with an outlet. Menu content, prices and timings are set by the
            outlet. The price recorded on your order at the time you place it is the price that applies to that
            order.
          </p>
        </LegalSection>

        <LegalSection heading="Order and payment status">
          <p>
            A newly created order awaits payment and is not confirmed until payment is successfully completed.
            The status shown by Zesto reflects the information we have received from our systems and the
            payment provider. Please see our Refund &amp; Cancellation page for what happens when an order or
            payment does not complete.
          </p>
        </LegalSection>

        <LegalSection heading="Your responsibilities">
          <LegalList
            items={[
              'Collect your order during the pickup window, using your order details.',
              'Provide accurate information and use Zesto lawfully.',
              'Organizations are responsible for the accuracy of their menus, prices, timings, and the food they prepare and provide.',
            ]}
          />
        </LegalSection>

        <LegalSection heading="Prohibited misuse">
          <LegalList
            items={[
              'Attempting to access accounts, data or systems you are not authorized to access.',
              'Interfering with or disrupting the service, or probing it for vulnerabilities without permission.',
              'Placing orders or payments fraudulently, or using Zesto to deceive others.',
              'Scraping or automated use that places unreasonable load on the service.',
            ]}
          />
        </LegalSection>

        <LegalSection heading="Availability and changes">
          <p>
            Zesto is under active development. Features may change, be added or be withdrawn, and the service
            may be unavailable from time to time, for example for maintenance. We may update these terms and
            the service without prior notice.
          </p>
        </LegalSection>

        <LegalSection heading="Intellectual property">
          <p>
            The Zesto name, website and software are protected by intellectual property rights. Outlets retain
            rights in the menu content they publish and grant Zesto permission to display it as part of the
            service. You may not copy or reuse Zesto materials except as permitted by law.
          </p>
        </LegalSection>

        <LegalSection heading="Third-party services and payments">
          <p>
            Zesto relies on third-party services, including sign-in and payment processing. Your use of those
            services may be subject to the providers&apos; own terms. Zesto is not responsible for the
            availability or conduct of third-party services beyond what applicable law requires.
          </p>
        </LegalSection>

        <LegalSection heading="Limitations">
          <p>
            Zesto is provided on an &ldquo;as available&rdquo; basis. To the extent permitted by law, Zesto is
            not liable for indirect or consequential loss arising from use of the service, or for the quality,
            safety or preparation of food, which is the responsibility of the outlet. Nothing in these terms
            limits any right you have that cannot be limited by law.
          </p>
        </LegalSection>

        <LegalSection heading="Changes to these terms">
          <p>
            We may revise these terms. The &ldquo;Last updated&rdquo; date above shows the latest revision.
            Continued use of Zesto after a change means you accept the revised terms.
          </p>
        </LegalSection>

        <LegalSection heading="Contact">
          <p>
            Questions about these terms: <SupportEmail />.
          </p>
        </LegalSection>
      </LegalPage>
    </PublicSiteLayout>
  );
}
