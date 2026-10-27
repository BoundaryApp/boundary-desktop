import React from 'react';
import type { HermesChatToolEvent, HermesProjectRecord } from '../../../shared/types/hermesChat';
import {
  formatToolCardMeta,
  toHostRelativePath,
  uniquePreserveOrder,
} from '../../../shared/hermesToolPaths';
import { FileActions, projectPathsOf } from './MessageActions';

export type ToolCardState = HermesChatToolEvent & {
  collapsed?: boolean;
  /** Paths inside the active project's mount, relative to it: these can be revealed. */
  projectPaths?: string[];
};


/**
 * Adds a tool event to the live turn's cards. A later event for the same tool keeps the
 * paths, and their Reveal actions, of the earlier ones (`tool.complete` without `args` has
 * none). Main gives the `tool.generating` card an id no later event reuses, so it goes once
 * that tool runs or finishes.
 */
export function withToolEvent(
  cards: ToolCardState[],
  event: HermesChatToolEvent,
  containerPath?: string | null
): ToolCardState[] {
  const next: ToolCardState = {
    ...event,
    paths: uniquePreserveOrder((event.paths ?? []).map((p) => toHostRelativePath(p, containerPath))),
    projectPaths: projectPathsOf(event.paths ?? [], containerPath),
    collapsed: event.status === 'done',
  };
  const kept =
    event.status === 'generating'
      ? cards
      : cards.filter(
          (c) => c.toolId === event.toolId || c.status !== 'generating' || c.name !== event.name
        );
  const existing = kept.find((c) => c.toolId === event.toolId);
  if (!existing) return [...kept, next];
  return kept.map((c) =>
    c === existing
      ? {
          ...existing,
          ...next,
          paths: uniquePreserveOrder([...(existing.paths ?? []), ...(next.paths ?? [])]),
          projectPaths: uniquePreserveOrder([
            ...(existing.projectPaths ?? []),
            ...(next.projectPaths ?? []),
          ]),
          collapsed: event.status === 'done' ? true : (existing.collapsed ?? false),
        }
      : c
  );
}

/** A file the agent touched: Reveal and Copy path on hover, when it maps to the host. */
const ToolPath: React.FC<{
  path: string;
  project: HermesProjectRecord | null;
  revealable: boolean;
  onNotice: (text: string) => void;
}> = ({ path, project, revealable, onNotice }) =>
  revealable && project ? (
    <li className="mono wb-tool-path">
      <span>{path}</span>
      <FileActions project={project} relativePath={path} onNotice={onNotice} />
    </li>
  ) : (
    <li className="mono" title={path}>
      {path}
    </li>
  );

export const ToolCard: React.FC<{
  card: ToolCardState;
  onToggle: () => void;
  project?: HermesProjectRecord | null;
  onNotice?: (text: string) => void;
}> = ({ card, onToggle, project = null, onNotice = () => undefined }) => {
  const projectPaths = new Set(card.projectPaths ?? []);
  const row = (p: string) => (
    <ToolPath
      key={p}
      path={p}
      project={project}
      revealable={projectPaths.has(p)}
      onNotice={onNotice}
    />
  );
  const meta = formatToolCardMeta({
    name: card.name,
    status: card.status,
    turn: card.turn,
    maxTurns: card.maxTurns,
  });
  const running = card.status === 'running' || card.status === 'generating';
  const paths = card.paths ?? [];
  const collapsed = card.collapsed !== false && !running;

  return (
    <div className="wb-tool">
      <button type="button" onClick={onToggle} className="meta">
        {running ? <i className="wb-spin" aria-hidden /> : null}
        <span className="label" title={meta}>
          {meta}
        </span>
        {card.durationSec != null && !running ? (
          <span className="dur">{card.durationSec.toFixed(1)}s</span>
        ) : null}
      </button>
      {!collapsed ? (
        <div>
          {card.summary ? <p className="summary">{card.summary}</p> : null}
          {paths.length > 0 ? <ul>{paths.map(row)}</ul> : null}
        </div>
      ) : paths.length > 0 ? (
        <ul>
          {paths.slice(0, 4).map(row)}
          {paths.length > 4 ? <li>+{paths.length - 4} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
};
