import { IonContent, IonPage } from '@ionic/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buttonClassName } from '../../components/ui/buttonClassName';
import { PUBLIC_LINKS } from './siteConfig';

const navLinkClasses = 'text-sm font-medium text-muted transition-colors hover:text-text';

export function PublicHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
        <Link to="/" className="text-xl font-semibold tracking-tight text-text" aria-label="Zesto home">
          Zesto
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-4 sm:gap-6">
          <Link to={PUBLIC_LINKS.explore} className={`${navLinkClasses} hidden sm:inline`}>
            Explore
          </Link>
          <Link to={PUBLIC_LINKS.signIn} className={`${navLinkClasses} hidden sm:inline`}>
            Organization sign-in
          </Link>
          <Link to={PUBLIC_LINKS.contact} className={`${navLinkClasses} hidden sm:inline`}>
            Contact
          </Link>
          <Link to={PUBLIC_LINKS.explore} className={buttonClassName('primary')}>
            Explore Menus
          </Link>
        </nav>
      </div>
    </header>
  );
}

const footerLinks = [
  { to: PUBLIC_LINKS.explore, label: 'Explore' },
  { to: PUBLIC_LINKS.privacy, label: 'Privacy' },
  { to: PUBLIC_LINKS.terms, label: 'Terms' },
  { to: PUBLIC_LINKS.refundCancellation, label: 'Refund & Cancellation' },
  { to: PUBLIC_LINKS.contact, label: 'Contact' },
];

export function PublicFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div>
          <p className="text-lg font-semibold text-text">Zesto</p>
          <p className="mt-1 text-sm text-muted">Know the demand before you cook.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3">
          {footerLinks.map((link) => (
            <Link key={link.to} to={link.to} className={navLinkClasses}>
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-xs text-muted">© {new Date().getFullYear()} Zesto. All rights reserved.</p>
      </div>
    </footer>
  );
}

/** Shell for the public marketing and policy pages: header, content, footer. */
export function PublicSiteLayout({ children }: { children: ReactNode }) {
  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="flex min-h-full flex-col">
          <PublicHeader />
          <main className="flex-1">{children}</main>
          <PublicFooter />
        </div>
      </IonContent>
    </IonPage>
  );
}
