import React from 'react';

/** The Circles mark, as the icon rail draws it, in the brand colour. */
export const CirclesMark: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    className="wb-circles-mark"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="2.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="3.2" cy="10.8" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12.8" cy="10.8" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
