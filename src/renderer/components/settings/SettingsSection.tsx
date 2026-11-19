import React from 'react';

/**
 * A titled group of settings rows. Everything in the section (rows, callouts, a lead line, a
 * sub-heading) sits in one stack whose gap spaces it, so no panel sets those margins itself.
 */
export const SettingsSection: React.FC<{
  /** The heading's id, which names the section. */
  id: string;
  title: React.ReactNode;
  className?: string;
  /** The section's own id, for a link that scrolls to it. */
  sectionId?: string;
  children: React.ReactNode;
}> = ({ id, title, className, sectionId, children }) => (
  <section
    id={sectionId}
    className={className ? `wb-settings-section ${className}` : 'wb-settings-section'}
    aria-labelledby={id}
  >
    <h2 id={id}>{title}</h2>
    <div className="wb-settings-rows">{children}</div>
  </section>
);

/**
 * One setting: its label and hint, then its controls. Controls sit on the right, or on their own
 * line under the label when `stacked`, which suits a text field and its button. With `onSubmit`
 * the row is a form. `details` holds more lines under the hint, each its own element.
 */
export const SettingsRow: React.FC<{
  label: React.ReactNode;
  hint?: React.ReactNode;
  details?: React.ReactNode;
  stacked?: boolean;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  children?: React.ReactNode;
}> = ({ label, hint, details, stacked = false, onSubmit, children }) => {
  const className = stacked ? 'wb-settings-row is-stacked' : 'wb-settings-row';
  const content = (
    <>
      <div className="wb-settings-copy">
        <p className="wb-settings-label">{label}</p>
        {hint ? <p className="wb-settings-hint">{hint}</p> : null}
        {details}
      </div>
      {stacked ? <div className="wb-settings-field">{children}</div> : children}
    </>
  );
  return onSubmit ? (
    <form className={className} onSubmit={onSubmit}>
      {content}
    </form>
  ) : (
    <div className={className}>{content}</div>
  );
};
