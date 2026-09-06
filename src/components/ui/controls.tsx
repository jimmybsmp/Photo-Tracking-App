import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** Small shared controls so every panel doesn't reinvent button styling. */

export function Button({
  active,
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; variant?: 'default' | 'primary' | 'danger' }) {
  const base = 'btn';
  const variantClass = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : '';
  return <button className={`${base} ${variantClass} ${active ? 'btn-active' : ''} ${className}`} {...props} />;
}

export function FilterChip({
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return <button className={`chip ${active ? 'chip-active' : ''}`} {...props} />;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`field ${className}`} {...rest} />;
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'mag' | 'pr' | 'warn' | 'good'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
