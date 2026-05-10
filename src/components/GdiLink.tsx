import Link from 'next/link';
import type { ReactNode } from 'react';

// Glossary-style link for the term "GDI". Renders the children with a
// dotted underline (the conventional affordance for "click for definition")
// and routes to the methodology page. Used everywhere GDI is mentioned in
// the UI so any first-time visitor can one-click to learn what it means.
//
// Style notes:
//   - decoration-dotted              the "perforated underscore"
//   - decoration-ink-dim/70          dim so it doesn't compete with primary links
//   - underline-offset-[3px]         clearance from descenders
//   - cursor-help                    extra affordance for "definition" intent
//   - hover state brightens          so the term reads as discoverable
export function GdiLink({
  children = 'GDI',
  className = '',
  href = '/methodology',
  title = 'GDI — Geographic Decentralisation Index. Click for methodology.',
}: {
  children?: ReactNode;
  className?: string;
  href?: string;
  title?: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={
        'underline decoration-dotted decoration-ink-dim/70 underline-offset-[3px] ' +
        'transition-colors hover:text-ink hover:decoration-ink ' +
        'cursor-help ' +
        className
      }
    >
      {children}
    </Link>
  );
}
