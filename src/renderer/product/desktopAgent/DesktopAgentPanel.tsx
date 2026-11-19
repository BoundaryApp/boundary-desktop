import React, { useCallback, useEffect, useRef } from 'react';
import { APP_NAME } from '../../../shared/buildIdentity';
import { BUILTIN_ASSISTANT_SLUG } from '../../../shared/types/hermesChat';
import { useOwnerDocument, useOwnerWindow } from '../../components/ui/ownerDocument';
import { useBuiltinName } from '../agentButton/agentActivity';
import { AgentChatPanel } from '../agentPanel/AgentChatPanel';
import { usePanelChat } from '../agentPanel/agentPanelChat';
import { AgentMark } from '../chat/ConversationMark';
import { requestChatOpen } from '../chat/chatOpenRequests';
import { openCircle } from '../circles/circlesNavigation';
import { dispatchAppCommand } from '../useAppShortcuts';
import { CirclesPanelTab } from './CirclesPanelTab';
import {
  leavePanelForWindow,
  panelCircleNow,
  setDesktopPanelOpen,
  setDesktopPanelTab,
  useDesktopPanelTab,
  type DesktopPanelTab,
} from './desktopPanel';
import './desktopAgent.css';

const TABS: { id: DesktopPanelTab; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'circles', label: 'Circles' },
];

const close = (): void => setDesktopPanelOpen(false);

/** ⤢ (§10): open the agent chat in Boundary's window, bring it forward and close the panel. */
function expand(chatId: string | null): void {
  requestChatOpen(chatId);
  leavePanelForWindow();
}

/** ⤢ on the Circles tab: the panel's Circle on the Circles screen, on the channel it showed. */
function expandCircle(): void {
  const key = panelCircleNow();
  if (key) openCircle(key);
  else dispatchAppCommand('go-circles');
  leavePanelForWindow();
}

/**
 * Nothing behind the panel reaches it (§12): drops of text or files are refused across its whole
 * window, with the no-drop cursor. Paste is left alone.
 */
function useRefusedDrops(): void {
  const doc = useOwnerDocument();
  useEffect(() => {
    const refuse = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    for (const type of ['dragenter', 'dragover', 'drop'] as const) doc.addEventListener(type, refuse, true);
    return () => {
      for (const type of ['dragenter', 'dragover', 'drop'] as const) doc.removeEventListener(type, refuse, true);
    };
  }, [doc]);
}

/** Something in the panel that takes Escape for itself when it is open. */
const OWNS_ESCAPE = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Escape closes the panel (§9), unless what is open in it takes the key: a sheet, menu or list,
 * which register their own handlers after the panel's, or a box that already claimed it.
 */
function useEscapeClosesPanel(): void {
  const doc = useOwnerDocument();
  const win = useOwnerWindow();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (doc.querySelector(OWNS_ESCAPE)) return;
      event.preventDefault();
      close();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener('keydown', onKeyDown);
  }, [doc, win]);
}

/** Opening puts focus in the composer (§3), once it has drawn. */
function useFocusComposer(root: React.RefObject<HTMLElement | null>, tab: DesktopPanelTab): void {
  const win = useOwnerWindow();
  useEffect(() => {
    const at = root.current;
    if (tab !== 'agent' || !at) return undefined;
    const focus = (): boolean => {
      const input = at.querySelector<HTMLElement>('textarea:not([aria-hidden])');
      input?.focus();
      return Boolean(input);
    };
    if (focus()) return undefined;
    const observer = new (win as Window & typeof globalThis).MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    observer.observe(at, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, tab, win]);
}

/**
 * The desktop panel (ADR 0058 §6 to §12), drawn into its own window: tabs for the built-in agent
 * and Circles under a bar with the agent's mark and name, ⤢ and ×. It stays open when the user
 * clicks into another app; Escape, × and the button close it.
 */
export const DesktopAgentPanel: React.FC = () => {
  const tab = useDesktopPanelTab();
  const name = useBuiltinName();
  const chatId = usePanelChat();
  const root = useRef<HTMLDivElement>(null);
  const onExpand = useCallback((id: string | null) => expand(id), []);

  useEscapeClosesPanel();
  useRefusedDrops();
  const doc = useOwnerDocument();
  useEffect(() => {
    doc.body.classList.add('wb-desktop-panel-doc');
    return () => doc.body.classList.remove('wb-desktop-panel-doc');
  }, [doc]);
  useFocusComposer(root, tab);

  return (
    <div className="wb-desktop-panel" ref={root}>
      <div className="wb-desktop-panel-bar">
        <span className="wb-desktop-panel-agent">
          <AgentMark agent={{ slug: BUILTIN_ASSISTANT_SLUG, displayName: name, builtIn: true }} size={24} />
          <b>{name}</b>
        </span>
        <div role="tablist" aria-label="Panel" className="wb-desktop-panel-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`wb-desktop-panel-tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => setDesktopPanelTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="wb-act"
          aria-label={`Open in ${APP_NAME}’s window`}
          title={`Open in ${APP_NAME}’s window`}
          onClick={() => (tab === 'agent' ? expand(chatId) : expandCircle())}
        >
          ⤢
        </button>
        <button type="button" className="wb-act" aria-label="Close" title="Close · Esc" onClick={close}>
          ×
        </button>
      </div>
      <div role="tabpanel" className="wb-desktop-panel-body">
        {tab === 'agent' ? <AgentChatPanel onExpand={onExpand} /> : <CirclesPanelTab />}
      </div>
    </div>
  );
};
