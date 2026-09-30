import { Link } from 'react-router-dom';
import { buttonClassName } from '../components/ui/buttonClassName';
import { Card } from '../components/ui/Card';
import { PublicSiteLayout } from '../features/public/PublicSiteLayout';
import { PUBLIC_LINKS } from '../features/public/siteConfig';

interface Step {
  title: string;
  text: string;
}

const customerSteps: Step[] = [
  { title: 'Explore', text: 'Find participating food outlets.' },
  { title: 'Choose a menu', text: 'Browse the upcoming menu and its pickup window.' },
  { title: 'Pre-order', text: 'Pick your items and quantities before ordering closes.' },
  { title: 'Pick up', text: 'Collect your food during the pickup window.' },
];

const organizationSteps: Step[] = [
  { title: 'Publish a menu', text: 'Set up the items, prices, ordering deadline and pickup times.' },
  { title: 'Receive demand', text: 'Customers pre-order the portions they want.' },
  { title: 'Prepare accordingly', text: 'Cook based on the demand you have actually received.' },
];

const reasons: Step[] = [
  {
    title: 'Plan before you prepare',
    text: 'Orders arrive before the food is cooked, so preparation starts from real demand instead of guesswork.',
  },
  {
    title: 'Clear upcoming menus',
    text: 'Customers see what is planned, what it costs, and when ordering closes and pickup opens.',
  },
  {
    title: 'Demand visibility',
    text: 'Outlets can see how many portions of each item have been requested.',
  },
  {
    title: 'A simple pre-order workflow',
    text: 'Choose items, review the order, and collect it at pickup. Online payments are being integrated into the Zesto ordering experience.',
  },
];

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-5 space-y-4">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-3">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
          >
            {index + 1}
          </span>
          <div>
            <p className="font-medium text-text">{step.title}</p>
            <p className="text-sm text-muted">{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function HomePage() {
  return (
    <PublicSiteLayout>
      <section className="border-b border-border bg-surface">
        <div className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-24">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">Zesto</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-text sm:text-5xl">
            Know the demand before you cook.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Zesto helps canteens, cafés, restaurants and campus food outlets publish upcoming menus and accept
            customer pre-orders, so they can plan preparation around the demand they have received.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link to={PUBLIC_LINKS.explore} className={buttonClassName('primary', 'px-6 py-3 text-base')}>
              Explore Menus
            </Link>
            <Link to={PUBLIC_LINKS.signIn} className={buttonClassName('secondary', 'px-6 py-3 text-base')}>
              Organization sign-in
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">How Zesto works</h2>
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Card className="p-6">
            <h3 className="text-lg font-semibold text-text">For customers</h3>
            <StepList steps={customerSteps} />
          </Card>
          <Card className="p-6">
            <h3 className="text-lg font-semibold text-text">For organizations</h3>
            <StepList steps={organizationSteps} />
          </Card>
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
          <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">Why Zesto</h2>
          <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
            {reasons.map((reason) => (
              <div key={reason.title}>
                <h3 className="text-lg font-semibold text-text">{reason.title}</h3>
                <p className="mt-2 leading-relaxed text-muted">{reason.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">What is Zesto?</h2>
        <div className="mt-5 max-w-2xl space-y-4 leading-relaxed text-muted">
          <p>
            Zesto is a platform that connects food outlets with their customers. An outlet publishes the menu for
            an upcoming day, customers pre-order the portions they want before the ordering deadline, and the
            outlet uses that demand to plan what to prepare.
          </p>
          <p>
            Zesto records demand, not stock: customers order the quantities they want, and outlets see the total
            requested for each item before they start cooking.
          </p>
        </div>
        <div className="mt-8">
          <Link to={PUBLIC_LINKS.explore} className={buttonClassName('primary', 'px-6 py-3 text-base')}>
            Explore Zesto
          </Link>
        </div>
      </section>
    </PublicSiteLayout>
  );
}
