import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
} from '@assistant-ui/react';
import { useAui, useAuiState } from '@assistant-ui/store';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { isElement, useCopyText, useOwnerDocument } from '../../components/ui/ownerDocument';
import type { HermesChatMessage, HermesProjectRecord } from '../../../shared/types/hermesChat';
import { projectRelativePath, uniquePreserveOrder } from '../../../shared/hermesToolPaths';
import {
  formatDayAndTime,
  formatDayLabel,
  formatMessageTime,
  formatMessageTimeFull,
  localDayKey,
} from '../../../shared/messageTime';
import { markdownToPlainText } from '../../../shared/markdownText';
import { isPreviewablePath, previewablePathsOf, PROJECTS_CONTAINER_ROOT } from '../../../shared/htmlPreview';
import { isCheckableFile } from '../../../shared/types/writingCheck';
import { messageTimeMs, needsDayDivider } from './messageMeta';
import { messageCustom } from './messageCustom';
import { useServerPath } from './HermesChatRuntimeProvider';
import { CONTINUE_RUN_CONFIG } from './hermesChatModelAdapter';
import { isReplyInterrupted } from './runInterrupts';

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

export function Icon({ children }: { children: React.ReactNode }) {
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

export const EditIcon = () => (
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
  /** Present when the user is in a Circle: opens the share sheet with this message (ADR 0042 §9). */
  onShare?: (share: { text: string; role: 'user' | 'assistant' }) => void;
  /** Present when the screen can show a writing check: sends the reply to the inspector. */
  onCheck?: (check: { messageId: string; markdown: string; source: string }) => void;
}

export const ReplyExtrasContext = createContext<ReplyExtras | null>(null);

/** ⋯ on replies: the rarer verbs, so the row stays short. On prompts it holds only Share. */
const MoreAction: React.FC = () => {
  const extras = useContext(ReplyExtrasContext);
  const aui = useAui();
  const isUser = useAuiState((s) => s.message.role === 'user');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyText = useCopyText();

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!extras || (isUser && !extras.onShare)) return null;
  const replyText = () => textOf(aui.message.getState());
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <span className={`wb-more${open ? ' is-open' : ''}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>
          <button
            type="button"
            className="wb-act"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={open}
            data-copied={copied ? 'true' : undefined}
          >
            {copied ? <CheckIcon /> : <MoreIcon />}
            <span className="wb-act-label">Copied</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="wb-menu" role="menu" side="top" align="start">
          {isUser ? null : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={pick(() => {
                  void copyText(markdownToPlainText(replyText())).then((done) => {
                    if (done) setCopied(true);
                  });
                })}
              >
                Copy as plain text
              </button>
              <button type="button" role="menuitem" onClick={pick(() => extras.onQuote(replyText()))}>
                Quote in reply
                <small>or select text to quote part of it</small>
              </button>
            </>
          )}
          {extras.onShare ? (
            <button
              type="button"
              role="menuitem"
              onClick={pick(() => extras.onShare?.({ text: replyText(), role: isUser ? 'user' : 'assistant' }))}
            >
              Share to Circle…
              <small>everyone in the Circle gets a copy</small>
            </button>
          ) : null}
          {!isUser && extras.saveTo ? (
            <button
              type="button"
              role="menuitem"
              onClick={pick(() => extras.saveTo?.onSave(replyText()))}
            >
              Save to {extras.saveTo.projectName}…
              <small>writes a .md file into the project folder</small>
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
    </span>
  );
};

/** Message text a selection may start or end in: a reply's prose or a prompt's bubble. */
const CHECKABLE_TEXT = '.wb-msg.is-assistant .wb-prose, .wb-msg.is-user .wb-bubble';

const elementOf = (node: Node) => (isElement(node) ? node : node.parentElement);

/** "Selection from a reply", "… from your message" or "… across 3 messages". */
function selectionSource(messages: Element[]): string {
  if (messages.length > 1) return `Selection across ${messages.length} messages`;
  return messages[0]?.classList.contains('is-user')
    ? 'Selection from your message'
    : 'Selection from a reply';
}

/** The part of `range` inside `element`, as text. */
function selectedPart(range: Range, element: Element): string {
  const part = element.ownerDocument.createRange();
  part.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
    part.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
    part.setEnd(range.endContainer, range.endOffset);
  }
  return part.toString().trim();
}

interface TextSelection {
  text: string;
  /** Only the selected message text, one paragraph per message: no names, times or buttons. */
  checkText: string;
  x: number;
  y: number;
  /** Inside one reply's prose: Quote applies. */
  quotable: boolean;
  /** The first selected message, for Show in chat. */
  messageId: string;
  source: string;
}

/**
 * Selecting text in a reply offers Quote and Copy just above the selection. Quote hands
 * the text to the composer, which sends it as a blockquote above what you type. With
 * `onCheck`, the popover also offers Check, on replies, prompts and selections across
 * messages (writing check spec, phase 3).
 */
export const SelectionQuote: React.FC<{
  onQuote: (text: string) => void;
  onCheck?: (check: { messageId: string; markdown: string; source: string }) => void;
}> = ({ onQuote, onCheck }) => {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const checkable = Boolean(onCheck);
  const doc = useOwnerDocument();
  const copyText = useCopyText();

  useEffect(() => {
    const update = () => {
      const current = doc.getSelection();
      if (!current || current.isCollapsed || current.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = current.getRangeAt(0);
      const text = current.toString().trim();
      const quotable = Boolean(
        elementOf(range.commonAncestorContainer)?.closest('.wb-msg.is-assistant .wb-prose')
      );
      const endsInMessages =
        Boolean(elementOf(range.startContainer)?.closest(CHECKABLE_TEXT)) &&
        Boolean(elementOf(range.endContainer)?.closest(CHECKABLE_TEXT));
      if (!text || !(quotable || (checkable && endsInMessages))) {
        setSelection(null);
        return;
      }
      const messages = [...doc.querySelectorAll('.wb-msg[data-message-id]')].filter((el) =>
        range.intersectsNode(el)
      );
      const checkText = [...doc.querySelectorAll(CHECKABLE_TEXT)]
        .filter((el) => range.intersectsNode(el))
        .map((el) => selectedPart(range, el))
        .filter(Boolean)
        .join('\n\n');
      const rect = range.getBoundingClientRect();
      setSelection({
        text,
        checkText,
        x: rect.left + rect.width / 2,
        y: rect.top,
        quotable,
        messageId: messages[0]?.getAttribute('data-message-id') ?? '',
        source: selectionSource(messages),
      });
    };
    const hide = () => setSelection(null);
    const win = doc.defaultView ?? window;
    doc.addEventListener('selectionchange', update);
    win.addEventListener('scroll', hide, true);
    return () => {
      doc.removeEventListener('selectionchange', update);
      win.removeEventListener('scroll', hide, true);
    };
  }, [checkable, doc]);

  if (!selection) return null;
  const finish = () => {
    doc.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  return (
    <div
      className="wb-sel-pop"
      style={{ left: selection.x, top: selection.y }}
      // Keep the selection alive while the pointer is on the popover.
      onMouseDown={(event) => event.preventDefault()}
    >
      {selection.quotable ? (
        <button
          type="button"
          onClick={() => {
            onQuote(selection.text);
            finish();
          }}
        >
          Quote
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          void copyText(selection.text);
          finish();
        }}
      >
        Copy
      </button>
      {onCheck ? (
        <button
          type="button"
          onClick={() => {
            onCheck({
              messageId: selection.messageId,
              markdown: selection.checkText,
              source: selection.source,
            });
            finish();
          }}
        >
          Check
        </button>
      ) : null}
    </div>
  );
};

/** The bound project, for mapping files the agent wrote to the host; null hides them. */
export interface ProjectFiles {
  project: HermesProjectRecord | null;
  onNotice: (text: string) => void;
  /** Sends a project file to the inspector's Check tab; absent hides Check. */
  onCheckFile?: (projectId: string, relativePath: string) => void;
  /** Opens an agent-written page in the preview sheet; absent hides Preview. */
  onPreview?: (containerPath: string) => void;
}

export const ProjectFilesContext = createContext<ProjectFiles | null>(null);

/** Preview for a page, Reveal in Finder (main keeps it inside the project folder) and Copy the host path. */
export const FileActions: React.FC<{
  project: HermesProjectRecord;
  relativePath: string;
  onNotice: (text: string) => void;
  onCheckFile?: (projectId: string, relativePath: string) => void;
  onPreview?: (containerPath: string) => void;
}> = ({ project, relativePath, onNotice, onCheckFile, onPreview }) => {
  const hostPath = `${project.hostPath.replace(/\/+$/, '')}/${relativePath}`;
  const containerPath = `${project.containerPath.replace(/\/+$/, '')}/${relativePath}`;
  const copyText = useCopyText();
  return (
    <span className="wb-file-acts">
      {onPreview && isPreviewablePath(relativePath) ? (
        <button type="button" className="wb-act" onClick={() => onPreview(containerPath)}>
          Preview
        </button>
      ) : null}
      <button
        type="button"
        className="wb-act"
        onClick={() => {
          void window.electronAPI.hermesChat
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
          void copyText(hostPath).then((done) => {
            if (done) onNotice('Path copied');
          });
        }}
      >
        Copy path
      </button>
      {onCheckFile && isCheckableFile(relativePath) ? (
        <button type="button" className="wb-act" onClick={() => onCheckFile(project.id, relativePath)}>
          Check
        </button>
      ) : null}
    </span>
  );
};

const FILES_SHOWN = 4;

/** Raw tool paths → the ones inside this project's mount, relative to it, each once. */
export function projectPathsOf(paths: string[], containerPath?: string | null): string[] {
  return uniquePreserveOrder(
    paths
      .map((p) => projectRelativePath(p, containerPath))
      .filter((p): p is string => p != null)
  );
}

/** The "Wrote" strip: rows of a label and actions, four shown and the rest behind "+N more". */
const WroteList: React.FC<{ rows: { key: string; actions: React.ReactNode }[] }> = ({ rows }) => {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, FILES_SHOWN);
  return (
    <div className="wb-files" aria-label="Files written">
      <span className="wb-files-label">Wrote</span>
      <ul>
        {shown.map((row) => (
          <li key={row.key} className="wb-file">
            <span className="mono" title={row.key}>
              {row.key}
            </span>
            {row.actions}
          </li>
        ))}
        {rows.length > shown.length ? (
          <li>
            <button type="button" className="wb-link" onClick={() => setExpanded(true)}>
              +{rows.length - shown.length} more
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
};

/**
 * Under a finished reply: the files that turn wrote inside the project, with Preview (pages),
 * Reveal and Copy path. Without a project, only pages under the projects mount, with Preview.
 * Tool cards stay progress (ADR 0006); this is where written files live after the turn
 * (spec decision 4c). Hermes history carries the tool rows, so it survives reloads.
 */
export const ReplyFiles: React.FC = () => {
  const context = useContext(ProjectFilesContext);
  const running = useAuiState((s) => s.message.status?.type === 'running');
  const raw = useAuiState((s) => (messageCustom(s.message).files ?? []).join('\n'));
  const project = context?.project ?? null;
  if (!context || running || !raw) return null;
  const paths = raw.split('\n');
  if (project) {
    const files = projectPathsOf(paths, project.containerPath);
    if (files.length === 0) return null;
    return (
      <WroteList
        rows={files.map((file) => ({
          key: file,
          actions: (
            <FileActions
              project={project}
              relativePath={file}
              onNotice={context.onNotice}
              onCheckFile={context.onCheckFile}
              onPreview={context.onPreview}
            />
          ),
        }))}
      />
    );
  }
  const onPreview = context.onPreview;
  const pages = onPreview ? previewablePathsOf(paths) : [];
  if (!onPreview || pages.length === 0) return null;
  return (
    <WroteList
      rows={pages.map((page) => ({
        key: page.slice(PROJECTS_CONTAINER_ROOT.length + 1),
        actions: (
          <span className="wb-file-acts">
            <button type="button" className="wb-act" onClick={() => onPreview(page)}>
              Preview
            </button>
          </span>
        ),
      }))}
    />
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
const BranchMark: React.FC = () => {
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
const MessageTime: React.FC = () => {
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

const CheckWritingIcon = () => (
  <Icon>
    <path d="M3 4.5h10M3 8h6" />
    <path d="M3 12c1-1 1.7-1 2.5 0s1.5 1 2.5 0 1.5-1 2.5 0" />
  </Icon>
);

/** Reply row: sends this reply's text to the inspector's Check tab (writing check spec, phase 2). */
const CheckAction: React.FC = () => {
  const extras = useContext(ReplyExtrasContext);
  const aui = useAui();
  const ms = useMessageTimeMs();
  if (!extras?.onCheck) return null;
  const check = () => {
    const message = aui.message.getState();
    extras.onCheck?.({
      messageId: message.id,
      markdown: textOf(message),
      source: ms == null ? 'Reply' : `Reply · ${formatDayAndTime(ms)}`,
    });
  };
  return (
    <button
      type="button"
      className="wb-act"
      aria-label="Check writing"
      data-tip="Check writing"
      data-guide-anchor="check-writing"
      onClick={check}
    >
      <CheckWritingIcon />
    </button>
  );
};

export const CopyAction: React.FC = () => (
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
      <MoreAction />
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
 * How a cut-short reply ended (run-control spec 1.5–1.6, 2.3): Boundary's saved note on a
 * hydrated reply, or the live run's cancelled status and whether Send now caused it.
 */
export function useReplyEnding(): ReplyEndingKind | null {
  return useAuiState((s) => {
    const saved = messageCustom(s.message).ending;
    if (saved) return saved;
    const status = s.message.status;
    if (status?.type !== 'incomplete' || status.reason !== 'cancelled') return null;
    // Sent over with Send now: the conversation moved on, so no Continue (spec 2.3).
    if (isReplyInterrupted(s.message.id)) return 'interrupted';
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
export const ReplyEnding: React.FC = () => {
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
  // Stopped before any text: LiveNoReplyNote says so, as the reloaded transcript does.
  if (ending === 'stopped-empty') return null;
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
  // Only when the count is known: unknown turns (copied branch history, WebUI-only
  // chats) show nothing rather than a wrong claim.
  const noTools = useAuiState((s) => messageCustom(s.message).toolCount === 0);
  const voiceName = useAuiState((s) => messageCustom(s.message).writingVoiceName ?? null);
  if (running) return null;
  return (
    <ActionBarPrimitive.Root className={`wb-acts${isLast ? ' is-pinned' : ''}`}>
      <Versions />
      <CopyAction />
      <CheckAction />
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
        {voiceName ? <span className="wb-reply-voice">In {voiceName} voice</span> : null}
        <MessageTime />
      </span>
    </ActionBarPrimitive.Root>
  );
};
