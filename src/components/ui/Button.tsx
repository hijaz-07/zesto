import type { ButtonHTMLAttributes } from 'react';
import { buttonClassName, type ButtonVariant } from './buttonClassName';

export type { ButtonVariant } from './buttonClassName';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClassName(variant, className)} {...props} />;
}
