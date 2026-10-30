import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  BookOpen,
  CircleHelp,
  Code,
  Database,
  KeyRound,
  MessageCircle,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import type {
  AssistantStackLifecycleStage,
  AssistantStackServiceProgress,
} from '../../../shared/types/assistantStack';
import { Button } from '../../components/ui/button';
import { useDismiss, useEscapeToClose } from '../../components/ui/use-dismiss';
import { Stepper, type StepperStep } from '../../components/ui/stepper';
import { ServiceProgressCards } from '../ServiceProgressCards';
import { describeStartupError } from '../../../shared/startupErrors';
import type { StartupDownload } from '../../../shared/startupDownload';
import { formatBytes } from '../../../shared/utils/format';
import {
  SLOW_STAGE_MS,
  STARTUP_TOOLS,
  slowStageHint,
  stageCopy,
  startupProgress,
  toolState,
  type StartupToolId,
  type StartupToolState,
  type StartupVariant,
} from './startupModel';
import { rendererExperiments } from '../../experiments';
import './startup.css';

const TOOL_ICONS: Record<StartupToolId, LucideIcon> = {
  assistant: MessageCircle,
  model: KeyRound,
  search: Search,
  memory: Network,
  research: BookOpen,
  automations: Workflow,
  database: Database,
  coding: Code,
};

/** A later launch that runs this long gets the tool story too. */
export const STORY_DELAY_MS = 6_000;
/** Story cards stay up long enough to read (Discord's tips are a known complaint). */
export const STORY_CARD_MS = 9_000;

export interface StartupScreenProps {
  /** `first-run` is the last setup step; `launch` is every later start. */
  variant: StartupVariant;
  stage?: AssistantStackLifecycleStage;
  /** Epoch ms the current stage began (lifecycle snapshot). */
  stageStartedAt?: number;
  /** Raw lifecycle message; shown only under Show details. */
  message?: string | null;
  services: AssistantStackServiceProgress[];
  /** Image bytes pulled so far (lifecycle snapshot). */
  download?: StartupDownload;
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** Setup's stepper, shown on first run so the last step reads as part of setup. */
  setupSteps?: { steps: StepperStep[]; currentId: string };
}

/** Matches the startup.css breakpoint where the details panel docks beside the column. */
const PANEL_BESIDE_QUERY = '(min-width: 1000px)';

function panelFitsBeside(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia(PANEL_BESIDE_QUERY).matches;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Full-window start-up screen (ADR 0029). No app chrome: the user can't do
 * anything until the assistant is up, so the screen shows the tools arriving
 * and what each one is for.
 */
export const StartupScreen: React.FC<StartupScreenProps> = ({
  variant,
  stage,
  stageStartedAt,
  message,
  services,
  download,
  error,
  onRetry,
  retrying = false,
  setupSteps,
}) => {
  const isError = Boolean(error) || stage === 'error';
  const isReady = !isError && stage === 'ready';
  const [now, setNow] = useState(() => Date.now());
  const mountedAt = useRef(now);
  const stageSeenAt = useRef<{ stage?: AssistantStackLifecycleStage; at: number }>({
    stage,
    at: now,
  });
  if (stageSeenAt.current.stage !== stage) stageSeenAt.current = { stage, at: now };

  useEffect(() => {
    if (isReady || isError) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isReady, isError]);

  const msInStage = now - (stageStartedAt ?? stageSeenAt.current.at);
  const highWater = useRef(0);
  // Leaving the error state is a new start; main resets its progress there too (a wave
  // boundary), so the bar and the download rate start again instead of at the failed peak.
  const attempt = useRef({ failed: isError, count: 0 });
  if (attempt.current.failed !== isError) {
    if (attempt.current.failed) {
      attempt.current.count += 1;
      highWater.current = 0;
    }
    attempt.current.failed = isError;
  }
  highWater.current = Math.max(highWater.current, startupProgress(stage, services, msInStage));
  const pct = Math.round(highWater.current * 100);

  const showStory =
    !isError && !isReady && (variant === 'first-run' || now - mountedAt.current >= STORY_DELAY_MS);
  const [card, setCard] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!showStory || paused || prefersReducedMotion()) return;
    const timer = setInterval(
      () => setCard((index) => (index + 1) % STARTUP_TOOLS.length),
      STORY_CARD_MS
    );
    return () => clearInterval(timer);
  }, [showStory, paused, card]);

  const [detailsOpen, setDetailsOpen] = useState(false);
  // An error opens the panel once, where it fits beside the column; it can be closed.
  useEffect(() => {
    if (isError && panelFitsBeside()) setDetailsOpen(true);
  }, [isError]);

  const states = STARTUP_TOOLS.map((tool) => toolState(tool, services));
  const highlighted = showStory ? card : -1;
  const lookAt = highlighted >= 0 ? highlighted : states.findIndex((s) => s === 'working');

  const failure = isError ? describeStartupError(error ?? message) : null;
  const headline = failure
    ? failure.title
    : isReady
      ? 'Your assistant is ready'
      : variant === 'first-run'
        ? 'Setting up your assistant'
        : 'Starting your assistant';
  const stageLine = failure ? failure.body : stageCopy(stage, variant);
  const downloading = useDownloadLine(download, now, !isError && !isReady, attempt.current.count);
  const slow = !isError && !isReady && !downloading && msInStage >= SLOW_STAGE_MS;

  return (
    <div
      className="su-root"
      data-state={isError ? 'error' : isReady ? 'ready' : 'working'}
      aria-busy={!isError && !isReady}
    >
      {setupSteps && (
        <div className="su-top">
          <Stepper steps={setupSteps.steps} currentId={setupSteps.currentId} />
        </div>
      )}
      <div className="su-column">
        <ToolRing
          states={states}
          highlighted={highlighted}
          lookAt={lookAt}
          mood={isError ? 'error' : isReady ? 'ready' : 'working'}
          onPick={showStory ? setCard : undefined}
        />

        {/* Fixed height, so a hint, story card or error never moves the ring or footer. */}
        <div className="su-stage">
          <div className="su-heading">
            <h1>{headline}</h1>
            <p role="status" aria-live="polite">
              {stageLine}
            </p>
            {downloading && <p className="su-hint">{downloading}</p>}
            {slow && <p className="su-hint">{slowStageHint(stage)}</p>}
          </div>

          {!isError && (
            <div
              className="su-bar"
              role="progressbar"
              aria-label="Start-up progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={stageLine}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          )}

          {!isError && (
            <div className="su-story-slot">
              {showStory && <StoryCard index={card} onPick={setCard} onPause={setPaused} />}
            </div>
          )}

          {isError && onRetry && (
            <Button type="button" className="su-retry" onClick={onRetry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Try again'}
            </Button>
          )}
        </div>

        <div className="su-footer">
          {!isError && !isReady && <WhyPopover firstRun={variant === 'first-run'} />}
          {!isReady && (
            <StartupDetails open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}>
              {error ? <RawError text={error} /> : message && <p className="su-log">{message}</p>}
              <ServiceProgressCards services={services} tone="start" />
            </StartupDetails>
          )}
        </div>
      </div>
    </div>
  );
};

/** Bytes are considered stalled after this long without growth; the line hides. */
const DOWNLOAD_IDLE_MS = 10_000;
/** Speed is averaged over this window. */
const RATE_WINDOW_MS = 5_000;

/** “1.2 GB downloaded · 9 MB/s” while image bytes are arriving, otherwise null. */
function useDownloadLine(
  download: StartupDownload | undefined,
  now: number,
  active: boolean,
  /** A new start: earlier samples would compare against the last attempt's bytes. */
  attempt: number
): string | null {
  const samples = useRef<{ attempt: number; list: { at: number; bytes: number }[] }>({
    attempt,
    list: [],
  });
  if (samples.current.attempt !== attempt) samples.current = { attempt, list: [] };
  const bytes = download?.receivedBytes ?? 0;
  const list = samples.current.list;
  if (bytes > 0 && (list.length === 0 || list[list.length - 1].bytes !== bytes)) {
    list.push({ at: Date.now(), bytes });
  }
  while (list.length > 2 && list[1].at < now - RATE_WINDOW_MS) list.shift();
  if (!active || bytes === 0) return null;
  const last = list[list.length - 1];
  if (now - last.at > DOWNLOAD_IDLE_MS) return null;
  const first = list[0];
  const seconds = (last.at - first.at) / 1000;
  const rate = seconds >= 1 ? (last.bytes - first.bytes) / seconds : 0;
  return rate > 0
    ? `${formatBytes(bytes)} downloaded · ${formatBytes(rate)}/s`
    : `${formatBytes(bytes)} downloaded`;
}

/** The error exactly as the stack reported it, for troubleshooting or a bug report. */
const RawError: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [text]);
  return (
    <div className="su-raw">
      <pre>{text}</pre>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy details'}
      </Button>
    </div>
  );
};

/**
 * Technical progress, one click away. Opens as a panel on the right edge so the
 * screen never grows taller than the window.
 */
export const StartupDetails: React.FC<{
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ open, onToggle, children }) => {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);

  // Focus follows the user's click: into the panel on open, back to the toggle on close.
  useEffect(() => {
    if (open && !wasOpen.current) closeRef.current?.focus();
    if (!open && wasOpen.current && document.activeElement === document.body) {
      toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useEscapeToClose(onToggle, !open);

  return (
    <div className="su-details">
      <button
        ref={toggleRef}
        type="button"
        className="su-pill"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        {open ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
        {open ? 'Hide details' : 'Show details'}
      </button>
      {open && (
        <aside id={panelId} className="su-panel" aria-label="Details">
          <header className="su-panel-head">
            <h2>Details</h2>
            <button
              ref={closeRef}
              type="button"
              className="su-panel-close"
              aria-label="Close details"
              onClick={onToggle}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="su-details-body">{children}</div>
        </aside>
      )}
    </div>
  );
};

/** Why start-up is slow, as a popover that opens up over the story card. */
const WhyPopover: React.FC<{ firstRun: boolean }> = ({ firstRun }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  useDismiss(rootRef, open, () => setOpen(false), { returnFocusTo: buttonRef });

  return (
    <div className="su-why" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="su-pill"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp aria-hidden="true" />
        Why does this take a while?
      </button>
      {open && (
        <div id={popoverId} className="su-why-popover" role="note">
          {firstRun ? (
            <p>
              Boundary is installing open-source AI tools that usually take a software developer to
              set up: web search, deep research, long-term memory, automations and a coding agent.
              It downloads them once, connects them to each other and runs each one in its own
              container on this Mac. You don’t need to do anything. Later launches skip the
              download.
            </p>
          ) : (
            <p>
              Each tool runs in its own container on this Mac. Boundary starts them and checks that
              they can reach each other and your model before you start chatting.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export type Mood = 'working' | 'ready' | 'error' | 'sleeping';

const START_WORDS: Record<StartupToolState, string> = {
  done: 'ready',
  working: 'starting',
  pending: 'waiting',
  error: 'failed',
};

export const ToolRing: React.FC<{
  states: StartupToolState[];
  highlighted: number;
  lookAt: number;
  mood: Mood;
  onPick?: (index: number) => void;
  /** Screen-reader word for each tile state. */
  words?: Record<StartupToolState, string>;
}> = ({ states, highlighted, lookAt, mood, onPick, words = START_WORDS }) => {
  const step = 360 / STARTUP_TOOLS.length;
  return (
    <div className="su-ring">
      <svg className="su-boundary" viewBox="0 0 300 300" aria-hidden="true">
        <circle cx="150" cy="150" r="140" />
      </svg>
      <Figure mood={mood} angle={lookAt >= 0 ? lookAt * step : null} />
      <ul className="su-tiles" aria-label="Your tools">
        {STARTUP_TOOLS.map((tool, index) => {
          const Icon = TOOL_ICONS[tool.id];
          const state = states[index];
          const label = `${tool.label}: ${words[state]}`;
          const box = (
            <span className="su-tile-box">
              <Icon aria-hidden="true" />
            </span>
          );
          return (
            <li
              key={tool.id}
              className="su-tile"
              data-state={state}
              data-highlighted={index === highlighted || undefined}
              style={{ '--a': `${index * step}deg` } as React.CSSProperties}
            >
              {onPick ? (
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={index === highlighted}
                  onClick={() => onPick(index)}
                >
                  {box}
                </button>
              ) : (
                <span role="img" aria-label={label}>
                  {box}
                </span>
              )}
              <span className="su-tile-label" aria-hidden="true">
                {tool.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** An experiment's figure when one draws the ring's centre, otherwise the face. */
const Figure: React.FC<{ mood: Mood; angle: number | null }> = (props) => {
  const RingFigure = rendererExperiments.find((e) => e.RingFigure)?.RingFigure ?? Face;
  return <RingFigure {...props} />;
};

/** The assistant: glances at whatever is being worked on, smiles when ready. */
const Face: React.FC<{ mood: Mood; angle: number | null }> = ({ mood, angle }) => {
  const rad = angle === null ? 0 : ((angle - 90) * Math.PI) / 180;
  const look = angle === null ? { x: 0, y: 0 } : { x: Math.cos(rad) * 3.5, y: Math.sin(rad) * 2.5 };
  return (
    <svg className="su-face" data-mood={mood} viewBox="0 0 80 80" aria-hidden="true">
      <line className="su-face-stalk" x1="40" y1="14" x2="40" y2="6" />
      <circle className="su-face-bulb" cx="40" cy="6" r="3.5" />
      <rect className="su-face-body" x="10" y="14" width="60" height="54" rx="18" />
      <g className="su-face-eyes" style={{ transform: `translate(${look.x}px, ${look.y}px)` }}>
        {mood === 'ready' ? (
          <>
            <path d="M24 42 q5 -7 10 0" />
            <path d="M46 42 q5 -7 10 0" />
          </>
        ) : mood === 'error' ? (
          <>
            <path d="M25 41 h8" />
            <path d="M47 41 h8" />
          </>
        ) : mood === 'sleeping' ? (
          <>
            <path d="M24 40 q5 5 10 0" />
            <path d="M46 40 q5 5 10 0" />
          </>
        ) : (
          <g className="su-face-blink">
            <rect x="25" y="34" width="8" height="13" rx="4" />
            <rect x="47" y="34" width="8" height="13" rx="4" />
          </g>
        )}
      </g>
    </svg>
  );
};

const StoryCard: React.FC<{
  index: number;
  onPick: (index: number) => void;
  onPause: (paused: boolean) => void;
}> = ({ index, onPick, onPause }) => {
  const tool = STARTUP_TOOLS[index];
  const Icon = TOOL_ICONS[tool.id];
  return (
    <section
      className="su-story"
      aria-roledescription="carousel"
      aria-label="What you’re getting"
      onMouseEnter={() => onPause(true)}
      onMouseLeave={() => onPause(false)}
      onFocus={() => onPause(true)}
      onBlur={() => onPause(false)}
    >
      <div className="su-card" key={tool.id} aria-roledescription="slide">
        <span className="su-card-icon">
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h2>{tool.title}</h2>
          <p>{tool.benefit}</p>
        </div>
      </div>
      <div className="su-dots">
        {STARTUP_TOOLS.map((item, i) => (
          <button
            key={item.id}
            type="button"
            aria-label={`Show ${item.title}`}
            aria-current={i === index || undefined}
            onClick={() => onPick(i)}
          />
        ))}
      </div>
    </section>
  );
};
