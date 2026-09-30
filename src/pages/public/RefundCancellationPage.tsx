import { Link } from 'react-router-dom';
import { SupportEmail } from '../../features/public/ConfigValue';
import { LegalList, LegalPage, LegalSection } from '../../features/public/LegalPage';
import { PublicSiteLayout } from '../../features/public/PublicSiteLayout';
import { PUBLIC_LINKS } from '../../features/public/siteConfig';

export function RefundCancellationPage() {
  return (
    <PublicSiteLayout>
      <LegalPage
        title="Refund & Cancellation Policy"
        intro={
          <>
            <p>
              Zesto customers pre-order food from outlets for an upcoming menu, with a defined ordering
              deadline and pickup window. This page explains what happens when an order is not completed,
              cancelled, or paid for incorrectly.
            </p>
            <p>
              Online payments are being integrated into the Zesto ordering experience and are not yet enabled
              for live orders. This policy describes how cancellations and refunds are handled.
            </p>
          </>
        }
      >
        <LegalSection heading="Before payment is completed">
          <p>
            When you place an order it is created as awaiting payment. It is not confirmed, and the outlet is
            not asked to prepare it, until payment has been successfully completed. If you leave without
            paying, or payment does not go through, you have not been charged for a confirmed order and no
            cancellation is needed.
          </p>
        </LegalSection>

        <LegalSection heading="Cancelling after payment">
          <p>
            A paid order can be cancelled only under specific conditions:
          </p>
          <LegalList
            items={[
              'Cancellation requests may be made before the applicable ordering deadline.',
              'Once ordering has closed or food preparation has begun, cancellation may not be available.',
              'Self-service cancellation is not yet available in Zesto. Cancellation requests are currently handled through support: email us with your order ID.',
            ]}
          />
        </LegalSection>

        <LegalSection heading="If an outlet cancels or cannot fulfil your order">
          <p>
            If an outlet cancels your paid order or is unable to fulfil it, you will receive a full refund of
            the affected paid order or items.
          </p>
        </LegalSection>

        <LegalSection heading="Payment failures">
          <p>
            If a payment fails but money was deducted from your account, the order will stay unconfirmed. Such
            amounts are normally returned to the original payment method by the payment provider or your bank.
            Please contact us with your order ID and payment details if the amount has not been returned, so
            we can look into it.
          </p>
        </LegalSection>

        <LegalSection heading="Duplicate or incorrect payments">
          <p>
            If you were charged more than once for the same order, or charged an incorrect amount because of a
            technical issue, contact us with your order ID. After we verify the payment records, we will
            refund the duplicate or excess amount.
          </p>
        </LegalSection>

        <LegalSection heading="How refunds are paid, and how long they take">
          <LegalList
            items={[
              'Approved refunds are intended to go back to the original payment method.',
              'Approved refunds will be initiated within 5 business days.',
              'After a refund is initiated, the actual time for the amount to be credited depends on the payment provider or your bank.',
            ]}
          />
        </LegalSection>

        <LegalSection heading="Contacting support">
          <p>
            To raise a cancellation, refund or payment issue, email <SupportEmail /> with your order ID and a
            short description of the problem. You can also find details on our{' '}
            <Link className="font-medium text-primary underline" to={PUBLIC_LINKS.contact}>
              Contact
            </Link>{' '}
            page.
          </p>
        </LegalSection>
      </LegalPage>
    </PublicSiteLayout>
  );
}
