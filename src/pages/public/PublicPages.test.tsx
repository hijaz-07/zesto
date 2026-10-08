import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactPage } from './ContactPage';
import { PrivacyPage } from './PrivacyPage';
import { RefundCancellationPage } from './RefundCancellationPage';
import { TermsPage } from './TermsPage';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/refund-cancellation" element={<RefundCancellationPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/explore" element={<div>Explore page</div>} />
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('public policy and contact pages', () => {
  it.each([
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Use'],
    ['/refund-cancellation', 'Refund & Cancellation Policy'],
    ['/contact', 'Contact'],
  ])('%s renders without any sign-in and with header and footer', (path, title) => {
    renderAt(path);

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'Terms' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'Refund & Cancellation' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'Contact' })).toBeInTheDocument();
  });

  it('shows visible placeholders instead of invented contact details when config is unset', () => {
    vi.stubEnv('VITE_PUBLIC_SUPPORT_EMAIL', '');
    vi.stubEnv('VITE_PUBLIC_OPERATOR_NAME', '');
    renderAt('/contact');

    expect(screen.getByTestId('support-email-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('operator-name-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /@/ })).not.toBeInTheDocument();
  });

  it('shows configured contact details as a mailto link', () => {
    vi.stubEnv('VITE_PUBLIC_SUPPORT_EMAIL', 'help@example.test');
    renderAt('/contact');

    expect(screen.getByRole('link', { name: 'help@example.test' })).toHaveAttribute(
      'href',
      'mailto:help@example.test',
    );
    expect(screen.queryByTestId('support-email-placeholder')).not.toBeInTheDocument();
  });

  it('refund policy states the decided cancellation and refund terms', () => {
    renderAt('/refund-cancellation');

    expect(screen.getByRole('heading', { name: 'Before payment is completed' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Payment failures' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Duplicate or incorrect payments' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cancelling an order yourself' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How much is refunded' })).toBeInTheDocument();
    expect(screen.getByText(/^While it is awaiting payment\.$/)).toBeInTheDocument();
    expect(screen.getByText(/while the order is confirmed and before the ordering deadline of its menu/)).toBeInTheDocument();
    expect(screen.getByText(/started preparing your order, you can no longer cancel it yourself/)).toBeInTheDocument();
    expect(screen.getByText(/Cancelling is final/)).toBeInTheDocument();
    expect(screen.getByText(/but you do not have to/)).toBeInTheDocument();
    expect(screen.getByText(/refunded in full: the whole amount you paid, with no cancellation fee/)).toBeInTheDocument();
    expect(screen.getByText(/A payment that failed is not refunded/)).toBeInTheDocument();
    expect(screen.getByText(/refunded in full automatically/)).toBeInTheDocument();
    expect(screen.getByText(/receive a full refund of the amount you paid/)).toBeInTheDocument();
    expect(screen.getByText(/initiated within 5 business days/)).toBeInTheDocument();
    expect(screen.queryByText(/to be confirmed/i)).not.toBeInTheDocument();
  });

  it('refund policy no longer says self-service cancellation or online payments are unavailable', () => {
    renderAt('/refund-cancellation');

    expect(screen.queryByText(/not yet available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not yet enabled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/being integrated/i)).not.toBeInTheDocument();
  });

  it('privacy policy states that raw card/UPI credentials are not stored', () => {
    renderAt('/privacy');

    expect(screen.getByText(/does not store raw card numbers or UPI credentials/)).toBeInTheDocument();
  });

  it('header Explore CTA leads to /explore', () => {
    renderAt('/terms');

    fireEvent.click(screen.getByRole('link', { name: 'Explore Menus' }));

    expect(screen.getByText('Explore page')).toBeInTheDocument();
  });
});
