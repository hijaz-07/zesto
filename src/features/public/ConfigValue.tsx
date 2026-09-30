import { getOperatorName, getSupportEmail } from './siteConfig';

const placeholderClasses =
  'rounded border border-dashed border-warning/60 bg-warning/10 px-1.5 py-0.5 text-warning';

/** Support email as a mailto link, or a visible placeholder when not yet configured. */
export function SupportEmail() {
  const email = getSupportEmail();
  if (!email) {
    return (
      <span className={placeholderClasses} data-testid="support-email-placeholder">
        [Support email to be provided]
      </span>
    );
  }
  return (
    <a className="font-medium text-primary underline" href={`mailto:${email}`}>
      {email}
    </a>
  );
}

/** Owner/operator name, or a visible placeholder when not yet configured. */
export function OperatorName() {
  const name = getOperatorName();
  if (!name) {
    return (
      <span className={placeholderClasses} data-testid="operator-name-placeholder">
        [Operator name to be provided]
      </span>
    );
  }
  return <span className="font-medium">{name}</span>;
}
