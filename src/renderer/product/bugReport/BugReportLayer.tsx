import React from 'react';
import { BugReportSheet } from './BugReportSheet';

/**
 * The report sheet's own layer, above whichever screen is showing. The caller marks the app
 * behind it inert while it's open.
 */
export const BugReportLayer: React.FC<{ screen: string; onClose: () => void }> = ({ screen, onClose }) => (
  <div className="workbench wb-report-layer">
    <BugReportSheet screen={screen} onClose={onClose} />
  </div>
);
