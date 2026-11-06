import type { InferenceProvenance } from './hermesChat';
import type { InferenceSlotId } from './onboarding';

/** A chain entry's source: a stored slot, or a model a Circle member shares (ADR 0034). */
export type InferenceChainSlot = InferenceSlotId | 'peer';

/** Which shared model a `peer` entry names. `providerId` is the provider's identity key (ADR 0032 §2). */
export interface PeerModelRef {
  circleId: string;
  providerId: string;
}

export interface InferenceChainEntry {
  slot: InferenceChainSlot;
  /** Blank or absent means the slot's own model. Required in practice for `peer`. */
  modelId?: string;
  /** Set when `slot` is `peer`. */
  peer?: PeerModelRef;
}

/** Ordered by preference; the router tries entries top to bottom (ADR 0033 §1). */
export type InferenceChain = InferenceChainEntry[];

/** The chains a chat could resolve through, most specific first (ADR 0033 §1). */
export interface InferenceChainLevels {
  chat?: InferenceChain | null;
  project?: InferenceChain | null;
  app?: InferenceChain | null;
}

export interface PickedInferenceChain {
  chain: InferenceChain;
  provenance: InferenceProvenance;
}

/** Why an entry can't be used right now. It stays in the chain so the user sees it (ADR 0033 §10). */
export type InferenceChainStaleReason =
  | 'slot-not-configured'
  | 'left-circle'
  | 'offer-withdrawn'
  | 'model-not-offered'
  /**
   * The user hasn't marked the provider Trusted. Until Hermes can ask before every tool call in a
   * turn (change request 0015), an untrusted provider's model doesn't serve (ADR 0034 §3).
   */
  | 'provider-untrusted'
  /** The provider isn't connected to this device now. The router skips them until they're back. */
  | 'provider-offline';

export interface InferenceChainEntryState {
  entry: InferenceChainEntry;
  /** Stable across chain edits; stickiness is keyed by it (ADR 0033 §7). */
  key: string;
  stale: InferenceChainStaleReason | null;
  /** The user may send privacy-locked prompts here (ADR 0033 §4, ADR 0034 §3). */
  private: boolean;
  /** Tokens the model accepts, when known. */
  contextLength?: number;
}

/** One entry of the app's stack as Inference shows it (settings spec decision 3). */
export interface InferenceStackEntry extends InferenceChainEntryState {
  /** A private project's request stops before this entry (ADR 0033 §4). */
  privateCut: boolean;
}

/** The app's stack, first to last, as main would plan it now. Nothing is sent to build it. */
export interface InferenceStack {
  entries: InferenceStackEntry[];
  /** The smallest known context among entries that can serve (ADR 0033 §8). */
  contextLength?: number;
  /** No entry may serve a private project, so private projects can't send. */
  noPrivate: boolean;
}
