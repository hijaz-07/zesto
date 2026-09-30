import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  secondary: 'bg-surface text-text border border-border hover:bg-background',
  ghost: 'bg-transparent text-text hover:bg-background',
  danger: 'bg-danger text-white hover:opacity-90',
};

/** Class names for a Button-styled element, e.g. a router `Link` that should look like a button. */
export function buttonClassName(variant: ButtonVariant = 'primary', className?: string): string {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    variantClasses[variant],
    className,
  );
}
