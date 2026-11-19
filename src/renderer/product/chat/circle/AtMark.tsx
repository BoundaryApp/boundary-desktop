import React from 'react';

/** The "@" that opens a count holding an unread mention; the row's name says so for screen readers. */
export const AtMark: React.FC = () => (
  <span className="wb-at-mark" aria-hidden="true">
    @
  </span>
);
