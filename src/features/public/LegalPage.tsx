import type { ReactNode } from 'react';
import { POLICY_LAST_UPDATED } from './siteConfig';

export interface LegalPageProps {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}

/** Readable single-column layout shared by the policy and contact pages. */
export function LegalPage({ title, intro, children }: LegalPageProps) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {POLICY_LAST_UPDATED}</p>
      {intro ? <div className="mt-6 space-y-3 leading-relaxed text-text">{intro}</div> : null}
      <div className="mt-8 space-y-8">{children}</div>
    </article>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-text">{heading}</h2>
      <div className="mt-3 space-y-3 leading-relaxed text-text">{children}</div>
    </section>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
