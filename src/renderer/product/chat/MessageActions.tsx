import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
} from '@assistant-ui/react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type { HermesChatMessage, HermesProjectRecord } from '../../../shared/types/hermesChat';
import { projectRelativePath, uniquePreserveOrder } from '../../../shared/hermesToolPaths';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import {
  formatDayLabel,
  formatMessageTime,
  formatMessageTimeFull,
  localDayKey,
} from '../../../shared/messageTime';
import { markdownToPlainText } from '../../../shared/markdownText';
import { messageTimeMs, needsDayDivider } from './messageMeta';
import { useServerPath } from './HermesChatRuntimeProvider';
import { CONTINUE_RUN_CONFIG } from './hermesChatModelAdapter';

// Hover row and day dividers for transcript messages (message-actions spec, Phase 1).
// The row is always mounted and revealed with CSS on hover or focus-within, so Tab
// reaches it and nothing reflows; ActionBar's `autohide` would unmount it instead.

function CopyIcon() {
  return (
    <svg className="wb-act-icon is-copy" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="wb-act-icon is-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="wb-act-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const EditIcon = () => (
  <Icon>
    <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    <path d="M9 4l3 3" />
  </Icon>
);

export const RetryIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5v3h-3" />
  </Icon>
);

const PrevIcon = () => (
  <Icon>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </Icon>
);

const NextIcon = () => (
  <Icon>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Icon>
);

const BranchIcon = () => (
  <Icon>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="4.5" r="1.5" />
    <path d="M4.5 5v6M11.5 6v.5c0 2.5-7 1.5-7 4" />
  </Icon>
);

/** Whether this transcript allows Edit / Retry at all (off in channels, spec Phase 2). */
export const RewindAllowedContext = createContext(true);

/** A branch request: the visible messages up to the cut, and the prompt to hand back. */
export interface BranchRequest {
  seed: HermesChatMessage[];
  draft?: string;
}

/** Starts a branch; null hides Branch (channels, spec Phase 3). */
export const BranchContext = createContext<((request: BranchRequest) => void) | null>(null);

interface SeedSource {
  role: string;
  content: readonly unknown[];
}

const partText = (part: unknown): string =>
  part && typeof part === 'object' && (part as { type?: string }).type === 'text'
    ? String((part as { text?: string }).text ?? '')
    : '';

const textOf = (message: SeedSource) => message.content.map(partText).join('');

/**
 * The branch cut for the message at `index` in the visible path. From a prompt: the
 * messages above it, with the prompt as the draft. From a reply: everything through it.
 */
export function branchRequestAt(messages: readonly SeedSource[], index: number): BranchRequest {
  const target = messages[index];
  const fromPrompt = target?.role === 'user';
  const seed = messages
    .slice(0, fromPrompt ? index : index + 1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m) }))
    .filter((m) => m.content.trim().length > 0);
  return fromPrompt && target ? { seed, draft: textOf(target) } : { seed };
}

/**
 * Branch works on any visible message, older versions included (that is how you
 * continue one), but needs the gateway and an idle thread.
 */
const BranchAction: React.FC = () => {
  const onBranch = useContext(BranchContext);
  const serverPath = useServerPath();
  useSyncExternalStore(
    serverPath?.subscribe ?? noSubscribe,
    serverPath?.getVersion ?? zeroVersion
  );
  const aui = useAui();
  const index = useAuiState((s) => s.message.index);
  const running = useAuiState((s) => s.thread.isRunning);
  if (!onBranch || running || serverPath?.canRewind() === false) return null;
  return (
    <button
      type="button"
      className="wb-act"
      aria-label="Branch to new chat"
      data-tip="Branch to new chat"
      onClick={() => onBranch(branchRequestAt(aui.thread.getState().messages, index))}
    >
      <BranchIcon />
    </button>
  );
};

const MoreIcon = () => (
  <svg className="wb-act-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

/** Reply extras (spec Phase 4); null hides the ⋯ menu. */
export interface ReplyExtras {
  onQuote: (text: string) => void;
  /** Present when a project is bound; Save writes a .md file there by default. */
  saveTo?: { projectName: string; onSave: (markdown: string) => void };
}

export const ReplyExtrasContext = createContext<ReplyExtras | null>(null);

/** ⋯ on replies: the rarer verbs, so the row stays short. */
const MoreAction: React.FC = () => {
  const extras = useContext(ReplyExtrasContext);
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!extras) return null;
  const replyText = () => textOf(aui.message.getState());
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <span className={`wb-more${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="wb-act"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        data-copied={copied ? 'true' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {copied ? <CheckIcon /> : <MoreIcon />}
        <span className="wb-act-label">Copied</span>
      </button>
      {open ? (
        <div className="wb-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={pick(() => {
              void navigator.clipboard
                ?.writeText(markdownToPlainText(replyText()))
                .then(() => setCopied(true))
                .catch((): void => undefined);
            })}
          >
            Copy as plain text
          </button>
          <button type="button" role="menuitem" onClick={pick(() => extras.onQuote(replyText()))}>
            Quote in reply
            <small>or select text to quote part of it</small>
          </button>
          {extras.saveTo ? (
            <button
              type="button"
              role="menuitem"
              onClick={pick(() => extras.saveTo?.onSave(replyText()))}
            >
              Save to {extras.saveTo.projectName}…
              <small>writes a .md file into the project folder</small>
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
};

/**
 * Selecting text in a reply offers Quote and Copy just above the selection. Quote hands
 * the text to the composer, which sends it as a blockquote above what you type.
 */
export const SelectionQuote: React.FC<{ onQuote: (text: string) => void }> = ({ onQuote }) => {
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(
    null
  );

  useEffect(() => {
    const update = () => {
      const current = window.getSelection();
      if (!current || current.isCollapsed || current.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = current.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const text = current.toString().trim();
      if (!text || !element?.closest('.wb-msg.is-assistant .wb-prose')) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelection({ text, x: rect.left + rect.width / 2, y: rect.top });
    };
    const hide = () => setSelection(null);
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!selection) return null;
  const finish = () => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  return (
    <div
      className="wb-sel-pop"
      style={{ left: selection.x, top: selection.y }}
      // Keep the selection alive while the pointer is on the popover.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onQuote(selection.text);
          finish();
        }}
      >
        Quote
      </button>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(selection.text).catch((): void => undefined);
          finish();
        }}
      >
        Copy
      </button>
    </div>
  );
};

/** The bound project, for mapping files the agent wrote to the host; null hides them. */
export interface ProjectFiles {
  project: HermesProjectRecord | null;
  onNotice: (text: string) => void;
}

export const ProjectFilesContext = createContext<ProjectFiles | null>(null);

/** Reveal in Finder (main keeps it inside the project folder) and Copy the host path. */
export const FileActions: React.FC<{
  project: HermesProjectRecord;
  relativePath: string;
  onNotice: (text: string) => void;
}> = ({ project, relativePath, onNotice }) => {
  const hostPath = `${project.hostPath.replace(/\/+$/, '')}/${relativePath}`;
  return (
    <span className="wb-file-acts">
      <button
        type="button"
        className="wb-act"
        onClick={() => {
          void hermesChatIPC
            .revealProjectFile({ projectId: project.id, relativePath })
            .then((result) => {
              if (!result.success) onNotice(result.error ?? 'Could not show the file.');
            });
        }}
      >
        Reveal
      </button>
      <button
        type="button"
        className="wb-act"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(hostPath)
            .then(() => onNotice('Path copied'))
            .catch((): void => undefined);
        }}
      >
        Copy path
      </button>
    </span>
  );
};

const FILES_SHOWN = 4;

/**
 * Under a finished reply: the files that turn wrote inside the project, with Reveal and
 * Copy path. Tool cards stay progress (ADR 0006); this is where written files live after
 * the turn (spec decision 4c). Hermes history carries the tool rows, so it survives reloads.
 */
export const ReplyFiles: React.FC = () => {
  const context = useContext(ProjectFilesContext);
  const running = useAuiState((s) => s.message.status?.type === 'running');
  const raw = useAuiState((s) => {
    const files = s.message.metadata?.custom?.files;
    return Array.isArray(files) ? files.filter((f) => typeof f === 'string').join('\n') : '';
  });
  const [expanded, setExpanded] = useState(false);
  const project = context?.project ?? null;
  if (!context || !project || running || !raw) return null;
  const files = uniquePreserveOrder(
    raw
      .split('\n')
      .map((p) => projectRelativePath(p, project.containerPath))
      .filter((p): p is string => p != null)
  );
  if (files.length === 0) return null;
  const shown = expanded ? files : files.slice(0, FILES_SHOWN);
  return (
    <div className="wb-files" aria-label="Files written">
      <span className="wb-files-label">Wrote</span>
      <ul>
        {shown.map((file) => (
          <li key={file} className="wb-file">
            <span className="mono">{file}</span>
            <FileActions project={project} relativePath={file} onNotice={context.onNotice} />
          </li>
        ))}
        {files.length > shown.length ? (
          <li>
            <button type="button" className="wb-link" onClick={() => setExpanded(true)}>
              +{files.length - shown.length} more
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
};

/** Where a branched chat's copied messages end; null outside a branch. */
export interface BranchMarkInfo {
  seededCount: number;
  parentTitle: string;
  branchedAt: string;
  onOpenParent: () => void;
}

export const BranchMarkContext = createContext<BranchMarkInfo | null>(null);

/** "Branched from <parent> · <time>", reusing the provider switch-mark style. */
export const BranchMark: React.FC = () => {
  const info = useContext(BranchMarkContext);
  if (!info) return null;
  const ms = Date.parse(info.branchedAt);
  return (
    <div className="wb-switch-mark wb-branch-mark">
      Branched from{' '}
      <button type="button" className="wb-link" onClick={info.onOpenParent}>
        {info.parentTitle}
      </button>
      {Number.isNaN(ms) ? null : <> · {formatMessageTime(ms)}</>}
    </div>
  );
};

/** Inside a message: the mark goes above the first message after the copied ones. */
export const BranchMarkBefore: React.FC = () => {
  const info = useContext(BranchMarkContext);
  const index = useAuiState((s) => s.message.index);
  return info && index === info.seededCount ? <BranchMark /> : null;
};

/** After the list: the mark while nothing has been sent in the branch yet. */
export const BranchMarkAtEnd: React.FC = () => {
  const info = useContext(BranchMarkContext);
  const count = useAuiState((s) => s.thread.messages.length);
  return info && count === info.seededCount ? <BranchMark /> : null;
};

/**
 * Edit / Retry only on messages Hermes still holds, when the chat supports rewinds,
 * and never mid-turn. Older versions stay viewable and copyable, not continuable.
 */
export function useCanRewind(): boolean {
  const allowed = useContext(RewindAllowedContext);
  const serverPath = useServerPath();
  useSyncExternalStore(
    serverPath?.subscribe ?? noSubscribe,
    serverPath?.getVersion ?? zeroVersion
  );
  const id = useAuiState((s) => s.message.id);
  const running = useAuiState((s) => s.thread.isRunning);
  return Boolean(allowed && serverPath?.canRewind() && serverPath.has(id) && !running);
}

const noSubscribe = () => (): void => undefined;
const zeroVersion = () => 0;

/** ‹ n / m › — visible whenever a message has more than one version, not only on hover. */
const Versions: React.FC = () => (
  <BranchPickerPrimitive.Root hideWhenSingleBranch className="wb-versions">
    <BranchPickerPrimitive.Previous className="wb-act" aria-label="Previous version">
      <PrevIcon />
    </BranchPickerPrimitive.Previous>
    <span className="wb-versions-count">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next className="wb-act" aria-label="Next version">
      <NextIcon />
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);

const useMessageTimeMs = () => useAuiState((s) => messageTimeMs(s.message));

/** Local time; the tooltip carries the full date and seconds. Renders nothing without a time. */
export const MessageTime: React.FC = () => {
  const ms = useMessageTimeMs();
  if (ms == null) return null;
  return (
    <time
      className="wb-msg-time"
      dateTime={new Date(ms).toISOString()}
      title={formatMessageTimeFull(ms)}
    >
      {formatMessageTime(ms)}
    </time>
  );
};

/** "Today" / "Yesterday" / date, above the first message of each local day. */
export const DayDivider: React.FC = () => {
  const show = useAuiState((s) =>
    needsDayDivider(
      s.message.index,
      messageTimeMs(s.message),
      messageTimeMs(s.thread.messages[s.message.index - 1])
    )
  );
  const ms = useMessageTimeMs();
  if (!show || ms == null) return null;
  return (
    <div className="wb-day" role="separator" data-day={localDayKey(ms)}>
      {formatDayLabel(ms)}
    </div>
  );
};

const CopyAction: React.FC = () => (
  <ActionBarPrimitive.Copy
    className="wb-act"
    copiedDuration={1400}
    aria-label="Copy"
    data-tip="Copy"
  >
    <CopyIcon />
    <CheckIcon />
    <span className="wb-act-label">Copied</span>
  </ActionBarPrimitive.Copy>
);

/**
 * Prompt row, aligned to the bubble's right edge: versions, time, then verbs.
 * Branch joins in Phase 3.
 */
export const UserMessageActions: React.FC = () => {
  const canRewind = useCanRewind();
  const edited = useAuiState((s) => s.message.branchCount > 1);
  return (
    <ActionBarPrimitive.Root className="wb-acts is-end">
      {edited ? <span className="wb-edited">edited</span> : null}
      <Versions />
      <MessageTime />
      <CopyAction />
      {canRewind ? (
        <ActionBarPrimitive.Edit className="wb-act" aria-label="Edit" data-tip="Edit">
          <EditIcon />
        </ActionBarPrimitive.Edit>
      ) : null}
      <BranchAction />
    </ActionBarPrimitive.Root>
  );
};

/**
 * Inline editor that replaces a prompt while it is being edited. It spans the whole
 * column, and sending replaces Hermes's history from this turn (version n + 1).
 */
export const UserEditComposer: React.FC = () => {
  const version = useAuiState((s) => s.message.branchCount + 1);
  return (
    <ComposerPrimitive.Root className="wb-msg is-user is-editing">
      <div className="wb-editor">
        <ComposerPrimitive.Input
          className="wb-editor-input"
          aria-label="Edit message"
          submitMode="ctrlEnter"
          autoFocus
        />
        <div className="wb-editor-foot">
          <span className="wb-editor-cap">
            Sends as version {version}. The reply below stays with version {version - 1}.
          </span>
          <ComposerPrimitive.Cancel className="wb-btn-ghost">
            Cancel <kbd>Esc</kbd>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send className="wb-btn-solid">
            Send <kbd>⌘↵</kbd>
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

/**
 * Shown above the composer while an older version is on screen: Hermes only keeps
 * the latest, so the conversation continues from there (CR 0001 R3).
 */
export const EarlierVersionNotice: React.FC = () => {
  const serverPath = useServerPath();
  useSyncExternalStore(
    serverPath?.subscribe ?? noSubscribe,
    serverPath?.getVersion ?? zeroVersion
  );
  const visible = useAuiState((s) => s.thread.messages.map((m) => m.id).join('\n'));
  const running = useAuiState((s) => s.thread.isRunning);
  if (!serverPath || running) return null;
  const shown = visible ? visible.split('\n') : [];
  const diverged = serverPath.messageIds().some((id, i) => shown[i] !== id);
  if (!diverged) return null;
  return (
    <p className="wb-version-note" role="status">
      You’re viewing an earlier version. Hermes keeps only the latest, so switch back with ‹ ›
      to continue the conversation.
    </p>
  );
};

const ContinueIcon = () => (
  <Icon>
    <path d="M5 3.5l7 4.5-7 4.5z" />
  </Icon>
);

export type ReplyEndingKind = 'stopped' | 'stopped-empty' | 'interrupted';

/**
 * How a cut-short reply ended (run-control spec 1.5–1.6): Boundary's saved note on a
 * hydrated reply, or the live run's cancelled status.
 */
export function useReplyEnding(): ReplyEndingKind | null {
  return useAuiState((s) => {
    const saved = (s.message.metadata as { custom?: { ending?: unknown } } | undefined)?.custom
      ?.ending;
    if (saved === 'stopped' || saved === 'interrupted') return saved;
    const status = s.message.status;
    if (status?.type !== 'incomplete' || status.reason !== 'cancelled') return null;
    const hasText = s.message.content.some(
      (part) => part.type === 'text' && part.text.trim().length > 0
    );
    return hasText ? 'stopped' : 'stopped-empty';
  });
}

/**
 * The line under a reply that was cut short. Stopped replies offer Continue while they
 * are the latest thing Hermes holds; Retry stays in the reply row. Interrupted replies
 * (Send now, Phase 2) offer nothing: the conversation has moved on.
 */
export const ReplyEnding: React.FC<{ speakerName: string }> = ({ speakerName }) => {
  const ending = useReplyEnding();
  const canRewind = useCanRewind();
  const isLast = useAuiState((s) => s.message.isLast);
  const id = useAuiState((s) => s.message.id);
  const aui = useAui();
  if (!ending) return null;
  if (ending === 'interrupted') {
    return (
      <p className="wb-ending is-interrupted">
        <span aria-hidden="true">↳</span> Interrupted by your next message
      </p>
    );
  }
  if (ending === 'stopped-empty') {
    return (
      <p className="wb-ending">
        <i className="wb-ending-mark" aria-hidden="true" />
        Stopped before {speakerName} replied
      </p>
    );
  }
  return (
    <p className="wb-ending">
      <i className="wb-ending-mark" aria-hidden="true" />
      Stopped by you
      {canRewind && isLast ? (
        <button
          type="button"
          className="wb-ending-act"
          onClick={() => aui.thread.startRun({ parentId: id, runConfig: CONTINUE_RUN_CONFIG })}
        >
          <ContinueIcon />
          Continue
        </button>
      ) : null}
    </p>
  );
};

/**
 * Reply row, aligned left: verbs, then time at the far end. The latest reply keeps
 * its row visible; none shows while the reply is still streaming.
 */
export const AssistantMessageActions: React.FC = () => {
  const running = useAuiState((s) => s.message.status?.type === 'running');
  const isLast = useAuiState((s) => s.message.isLast);
  const canRewind = useCanRewind();
  // Only when the count is known: unknown turns (HTTP fallback, copied branch history,
  // WebUI-only chats) show nothing rather than a wrong claim.
  const noTools = useAuiState((s) => s.message.metadata?.custom?.toolCount === 0);
  if (running) return null;
  return (
    <ActionBarPrimitive.Root className={`wb-acts${isLast ? ' is-pinned' : ''}`}>
      <Versions />
      <CopyAction />
      {canRewind ? (
        <ActionBarPrimitive.Reload className="wb-act" aria-label="Retry" data-tip="Retry">
          <RetryIcon />
        </ActionBarPrimitive.Reload>
      ) : null}
      <BranchAction />
      <MoreAction />
      {noTools ? (
        <span
          className="wb-no-tools"
          title="Hermes ran no tools for this reply, so nothing it describes was done by a tool."
        >
          No tools used
        </span>
      ) : null}
      <span className="wb-acts-end">
        <MessageTime />
      </span>
    </ActionBarPrimitive.Root>
  );
};
