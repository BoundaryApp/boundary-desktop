import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import { listStoredHermesProjects, replaceStoredHermesProjects } from '../services/assistant/hermes/hermesProjectStore';
import { circlesKeptByWipe, getProviderSettings } from '../services/circles/circlesStore';
import { dropAppEntries } from '../services/onboarding/OpenAiOnboardingStore';
import { dropChatFallbacksInEveryStore } from './hermesAgentsStores';

/**
 * Clear the app default, fallbacks and project and chat fallbacks that name a Circle the wipe
 * removed (ADR 0039 §2). Runs before anything reads them, so it needs no Circles running. On a
 * Mac that wiped in an earlier build, a Circle the user left since looks the same and goes too.
 */
export function dropWipedCircleReferences(dir?: string): void {
  const kept = circlesKeptByWipe();
  const isGone = (entry: InferenceChainEntry) => entry.slot === 'peer' && !kept.has(entry.peer?.circleId ?? '');
  const providers = getProviderSettings();
  dropAppEntries(isGone, (providerId) => providers[providerId]?.trusted === true);
  const projects = listStoredHermesProjects();
  if (projects.some((project) => project.inference?.fallbacks?.some(isGone))) {
    replaceStoredHermesProjects(
      projects.map((project) =>
        project.inference?.fallbacks?.some(isGone)
          ? { ...project, inference: { ...project.inference, fallbacks: project.inference.fallbacks.filter((entry) => !isGone(entry)) } }
          : project
      )
    );
  }
  dropChatFallbacksInEveryStore(isGone, dir);
}
