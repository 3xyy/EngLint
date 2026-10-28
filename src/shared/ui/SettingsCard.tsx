import { useId, type ReactNode } from 'react';

/** A section of the options page: a card with its title (the region's name), a one-line description, then its controls. */
export function SettingsCard({ id, title, description, children }: { id?: string; title: string; description: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section id={id} className="settings-card" aria-labelledby={headingId}>
      <header className="settings-card-head">
        <h2 id={headingId}>{title}</h2>
        <p className="settings-card-desc">{description}</p>
      </header>
      {children}
    </section>
  );
}
