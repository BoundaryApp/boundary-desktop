import React from 'react';

/** A titled box on an add-on's page, with an optional lead line. */
export const Panel: React.FC<{ title: string; lead?: React.ReactNode; children?: React.ReactNode }> = ({
  title,
  lead,
  children,
}) => (
  <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4">
    <h2 className="font-medium text-fg">{title}</h2>
    {lead ? <p className="text-xs leading-relaxed text-fg-muted">{lead}</p> : null}
    {children}
  </section>
);
