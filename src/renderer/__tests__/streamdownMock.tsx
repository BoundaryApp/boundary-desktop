import React from 'react';

/**
 * Renders a reply's markdown as plain text, so tests find it by its words. Load it with
 * `vi.mock('streamdown', () => import('<path>/streamdownMock'))`.
 */
export const Streamdown = ({ children }: { children: string }) => <div>{children}</div>;
