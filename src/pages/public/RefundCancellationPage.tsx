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
              deadline and pickup window. This page explains what happens when an order is cancelled, is not
              completed, or is paid for incorrectly.
            </p>
            <p>
              You can cancel an eligible order yourself from its order page. When a paid order is cancelled,
              the full amount you paid is refunded to your original payment method.
            </p>
          </>
        }
      >
        <LegalSection heading="Before payment is completed">
          <p>
            When you place an order it is created as awaiting payment. It is not confirmed, and the outlet is
            not asked to prepare it, until payment has been successfully completed. While it is awaiting
            payment you can cancel it from its order page; nothing has been charged for it. If you simply
            leave without paying, or payment does not go through, no cancellation is needed.
          </p>
        </LegalSection>

        <LegalSection heading="Cancelling an order yourself">
          <p>
            You can cancel an order from its order page in Zesto:
          </p>
          <LegalList
            items={[
              'While it is awaiting payment.',
              'After payment, while the order is confirmed and before the ordering deadline of its menu.',
              'Once ordering has closed, or the outlet has started preparing your order, you can no longer cancel it yourself.',
              'You may tell us why you are cancelling, but you do not have to.',
              'Cancelling is final. A cancelled order cannot be reinstated; if you still want the food, place a new order while ordering is open.',
            ]}
          />
          <p>
            If you need to cancel an order that is no longer eligible, contact the outlet or our support team
            with your order ID.
          </p>
        </LegalSection>

        <LegalSection heading="If an outlet cancels or cannot fulfil your order">
          <p>
            An outlet can cancel your order if, for example, an item is unavailable, the outlet is closed, or
            it cannot fulfil the order in time. It can do so until the order has been picked up. If the
            outlet cancels a paid order you will receive a full refund of the amount you paid, and you will be
            notified of the cancellation and the refund.
          </p>
        </LegalSection>

        <LegalSection heading="How much is refunded">
          <LegalList
            items={[
              'A cancelled paid order is refunded in full: the whole amount you paid, with no cancellation fee and no deduction for payment-provider charges.',
              'A payment that failed is not refunded, because the order was never confirmed.',
              'If your payment reaches us only after the order was cancelled, it is refunded in full automatically.',
            ]}
          />
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
              'Refunds go back to the original payment method.',
              'When a paid order is cancelled, the refund is started automatically; you do not need to ask for it. Its progress is shown on the order page.',
              'A refund that needs to be handled manually will be initiated within 5 business days.',
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
