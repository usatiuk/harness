import type { ReactNode } from "react";

export function SectionHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="section-heading">
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
    </header>
  );
}

export function SettingsGroup({
  title,
  children,
  className = "",
  action,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`settings-group ${className}`}>
      {action ? (
        <header className="settings-group-header">
          <h3>{title}</h3>
          {action}
        </header>
      ) : (
        <h3>{title}</h3>
      )}
      {children}
    </section>
  );
}
