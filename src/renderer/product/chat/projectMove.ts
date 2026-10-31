import { formatInferenceChipTitle } from '../../../shared/inferenceDisplay';
import type {
  HermesChatThreadSummary,
  HermesProjectRecord,
  SessionInferenceOverride,
  SessionProjectMark,
} from '../../../shared/types/hermesChat';
import type { InferenceChainSlot } from '../../../shared/types/inferenceChain';
import type { InferenceProvidersStatus } from '../../../shared/types/onboarding';
import { displayHostPath } from './chatTelemetryFormat';

// ADR 0024: conversations live in a project, and Move is the one way to change it.

/** Conversations filed under a project. DMs are never filed: they work in a folder. */
export function isFiled(thread: HermesChatThreadSummary): boolean {
  return thread.kind !== 'dm';
}

export function inProject(
  thread: HermesChatThreadSummary,
  projectId: string | null
): boolean {
  return isFiled(thread) && (thread.projectId ?? null) === projectId;
}

/** Filed conversations per project id, with `none` for No project (the rail menu's counts). */
export function projectCounts(
  threads: readonly HermesChatThreadSummary[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const thread of threads) {
    if (!isFiled(thread)) continue;
    const key = thread.projectId ?? 'none';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface EffectiveInference {
  slot: InferenceChainSlot;
  modelId: string;
  /** Where it comes from, in the inspector's words. */
  source: 'chat' | 'project' | 'app';
}

/** Chat override → the project's pin → app default (0017 as amended by 0024). */
export function effectiveInference(
  project: HermesProjectRecord | null,
  override: SessionInferenceOverride | null,
  status: InferenceProvidersStatus | null
): EffectiveInference | null {
  if (override) return { slot: override.provider, modelId: override.modelId, source: 'chat' };
  const pin = project?.inference;
  if (pin && pin.mode !== 'inherit') {
    const slot = status?.slots[pin.mode];
    const modelId = pin.modelId?.trim() || slot?.modelId || '';
    return { slot: pin.mode, modelId, source: 'project' };
  }
  const shared = status?.appSharedModel;
  if (shared) return { slot: 'peer', modelId: shared.modelId ?? '', source: 'app' };
  const appDefault = status?.appDefault ?? null;
  if (!appDefault) return null;
  return { slot: appDefault, modelId: status?.slots[appDefault]?.modelId ?? '', source: 'app' };
}

/** OpenRouter is the cloud slot; Local runs on this Mac. */
function isCloud(inference: EffectiveInference | null): boolean {
  return inference?.slot === 'openrouter';
}

function inferenceLabel(inference: EffectiveInference | null): string {
  if (!inference) return 'no model';
  return inference.modelId
    ? formatInferenceChipTitle(inference.slot, inference.modelId)
    : formatInferenceChipTitle(inference.slot, '').replace(/ · $/, '');
}

export type MoveEffect =
  | { kind: 'folder'; text: string }
  | { kind: 'sources'; text: string }
  | { kind: 'history'; text: string }
  | { kind: 'inference'; text: string }
  | { kind: 'cloud'; text: string };

/** What a move changes, in the order the sheet lists it. */
export function moveEffects(input: {
  agentName: string;
  /** The single source project, or undefined when the chats come from several. */
  from: HermesProjectRecord | null | undefined;
  to: HermesProjectRecord | null;
  /** Extra source folders on the target project beyond its own. */
  extraSources?: number | null;
  inferenceBefore: EffectiveInference | null;
  inferenceAfter: EffectiveInference | null;
  /** A DM's move changes the folder it works in; nothing is re-filed. */
  isDm?: boolean;
}): MoveEffect[] {
  const { agentName, from, to, inferenceBefore, inferenceAfter } = input;
  const effects: MoveEffect[] = [];
  effects.push({
    kind: 'folder',
    text: to
      ? `${agentName} works in ${displayHostPath(to.hostPath)} from the next message.`
      : `${agentName} works without a project folder from the next message. Project files and sources won’t be available.`,
  });
  if (to && input.extraSources != null) {
    effects.push({
      kind: 'sources',
      text:
        input.extraSources > 0
          ? `Sources: this folder and ${input.extraSources} more from ${to.name}.`
          : `Sources: ${to.name}’s folder only.`,
    });
  }
  effects.push({
    kind: 'history',
    text: `Earlier messages stay as written.${
      from ? ` Links to files in ${displayHostPath(from.hostPath)} still open.` : ''
    } A line in the transcript marks the ${input.isDm ? 'change' : 'move'}.`,
  });
  const before = inferenceLabel(inferenceBefore);
  const after = inferenceLabel(inferenceAfter);
  if (inferenceAfter && isCloud(inferenceAfter) && !isCloud(inferenceBefore)) {
    effects.push({
      kind: 'cloud',
      text: `Inference moves to the cloud: ${after}. The next reply sends this chat’s history, and any files ${agentName} reads, to OpenRouter.`,
    });
  } else if (before !== after) {
    effects.push({ kind: 'inference', text: `Inference changes from ${before} to ${after}.` });
  } else {
    effects.push({ kind: 'inference', text: `Inference stays ${after}.` });
  }
  return effects;
}

/** The transcript line for a move or a DM folder change. */
export function projectMarkText(
  mark: SessionProjectMark,
  projects: readonly HermesProjectRecord[],
  agentName: string
): string {
  const name = (id: string | null, fallback?: string) =>
    id ? (projects.find((p) => p.id === id)?.name ?? fallback ?? 'a removed project') : 'No project';
  const to = mark.toProjectId ? projects.find((p) => p.id === mark.toProjectId) : null;
  const path = to ? displayHostPath(to.hostPath) : mark.toPath ? displayHostPath(mark.toPath) : null;
  if (mark.kind === 'folder') {
    return mark.toProjectId
      ? `${agentName} now works in ${name(mark.toProjectId, mark.toName)}${path ? ` · ${path}` : ''}`
      : `${agentName} now works without a project folder`;
  }
  return `Moved from ${name(mark.fromProjectId, mark.fromName)} to ${name(mark.toProjectId, mark.toName)}${
    path ? ` · ${path}` : ''
  }`;
}
