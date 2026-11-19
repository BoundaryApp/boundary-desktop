import React from 'react';

/**
 * The start-up screen's face, still and redrawn for 14px: the rounded head, the antenna and the
 * pill eyes, in the brand colour with no square behind it. The eyes are holes, so the panel shows
 * through them in either theme. The viewBox is cropped close to the head so the face reads at the
 * same weight as the speech bubble that marks the agent's chats.
 */
export const AgentFace: React.FC = () => (
  <svg viewBox="0.5 0.3 13 13" aria-hidden="true">
    <path fill="currentColor" d="M6.5 3.4h1v1h-1z" />
    <circle cx="7" cy="2.2" r="1.05" fill="currentColor" />
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M4.8 4.2h4.4A2.8 2.8 0 0 1 12 7v2.7a2.8 2.8 0 0 1-2.8 2.8H4.8A2.8 2.8 0 0 1 2 9.7V7a2.8 2.8 0 0 1 2.8-2.8zM5.15 6.4a.85.85 0 0 0-.85.85v1.7a.85.85 0 0 0 1.7 0v-1.7a.85.85 0 0 0-.85-.85zM8.85 6.4a.85.85 0 0 0-.85.85v1.7a.85.85 0 0 0 1.7 0v-1.7a.85.85 0 0 0-.85-.85z"
    />
  </svg>
);
