import { Card } from '../../components/ui/Card';
import { OperatorName, SupportEmail } from '../../features/public/ConfigValue';
import { LegalPage } from '../../features/public/LegalPage';
import { PublicSiteLayout } from '../../features/public/PublicSiteLayout';

export function ContactPage() {
  return (
    <PublicSiteLayout>
      <LegalPage
        title="Contact"
        intro={<p>Questions about Zesto, an order, a payment, or your account? Get in touch.</p>}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-text">Support</h2>
            <p className="mt-2 text-sm text-muted">
              For order, payment, refund and account questions. Please include your order ID if you have one.
            </p>
            <p className="mt-3">
              <SupportEmail />
            </p>
          </Card>
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-text">Operated by</h2>
            <p className="mt-2 text-sm text-muted">The owner/operator of the Zesto service.</p>
            <p className="mt-3">
              <OperatorName />
            </p>
          </Card>
        </div>
      </LegalPage>
    </PublicSiteLayout>
  );
}
