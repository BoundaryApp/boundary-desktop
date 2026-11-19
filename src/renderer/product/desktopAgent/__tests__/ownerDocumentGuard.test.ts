import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop panel draws these files in a second window (ADR 0058). There, the page's own
 * `document` and `window` are the hidden app window, and `instanceof Node` fails for the panel's
 * elements, which come from another realm. They use `useOwnerDocument`, `useOwnerWindow`,
 * `isNode` and `isElement` instead.
 */
const DRAWN_IN_THE_PANEL = [
  'components/ui/interrupt-card.tsx',
  'components/ui/popover.tsx',
  'components/ui/use-dismiss.ts',
  'components/ui/select.tsx',
  'components/ui/info-tip.tsx',
  'product/chat/MessageActions.tsx',
  'product/chat/ThreadMessages.tsx',
  'product/chat/WorkbenchThread.tsx',
  'product/chat/ThreadInterrupts.tsx',
  'product/chat/WritingVoiceChips.tsx',
  'product/chat/useRunQueueControl.ts',
  'product/agentPanel/AgentChatPanel.tsx',
  'product/desktopAgent/DesktopAgentPanel.tsx',
  'product/desktopAgent/CirclesPanelTab.tsx',
  'product/circles/CirclesDock.tsx',
  'product/chat/circle/CircleThread.tsx',
  'product/chat/circle/DirectThread.tsx',
  'product/chat/circle/LinkConfirmSheet.tsx',
  'product/chat/circle/Reactions.tsx',
  'product/chat/circle/threadParts.tsx',
  'product/circles/useCircleViewing.ts',
];

// The clipboard too: the page's navigator refuses to write while the page isn't focused.
const PAGE_GLOBALS =
  /\bnavigator\.clipboard\b|\bdocument\.(querySelector|querySelectorAll|addEventListener|removeEventListener|activeElement|hasFocus|body|getSelection)\b|\bwindow\.(addEventListener|removeEventListener|getSelection)\b|\binstanceof (Node|Element|HTMLElement)\b/;

function codeLines(file: string): { line: number; text: string }[] {
  const source = readFileSync(resolve(__dirname, '../../..', file), 'utf8');
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

describe('UI the desktop panel draws', () => {
  it.each(DRAWN_IN_THE_PANEL)('%s reads its own document and window', (file) => {
    const offending = codeLines(file)
      .filter(({ text }) => PAGE_GLOBALS.test(text))
      .map(({ line, text }) => `${file}:${line} ${text.trim()}`);
    expect(offending).toEqual([]);
  });

  // Streamdown's link, code and table overlays default to the page's body, in the hidden window.
  it.each(DRAWN_IN_THE_PANEL.filter((file) => /<Streamdown\b/.test(readFileSync(resolve(__dirname, '../../..', file), 'utf8'))))(
    '%s gives Streamdown the document it renders in for its overlays',
    (file) => {
      const source = readFileSync(resolve(__dirname, '../../..', file), 'utf8');
      const tags = source.split('<Streamdown').slice(1).map((rest) => rest.slice(0, rest.indexOf('>')));
      expect(tags.filter((tag) => !/\bportal=/.test(tag))).toEqual([]);
    }
  );
});
