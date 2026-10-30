/**
 * Why the composer can't send right now, most pressing first: the folder is still
 * connecting, the assistant is restarting for an inference switch, a credential prompt or an
 * approval waits on an answer, or the local model was found unreachable.
 */
export type ComposerBlock =
  | 'connecting'
  | 'restarting'
  | 'credential'
  | 'approval'
  | 'offline'
  | 'private';

export function composerBlockFor(state: {
  connecting: boolean;
  restarting: boolean;
  credential: boolean;
  approval: boolean;
  offline: boolean;
  private: boolean;
}): ComposerBlock | null {
  if (state.connecting) return 'connecting';
  if (state.restarting) return 'restarting';
  if (state.credential) return 'credential';
  if (state.approval) return 'approval';
  if (state.offline) return 'offline';
  if (state.private) return 'private';
  return null;
}

const PLACEHOLDER: Record<ComposerBlock, string> = {
  connecting: 'Connecting folder…',
  restarting: 'Wait for the assistant to come back…',
  credential: 'Answer the prompt above to continue…',
  approval: 'Answer the approval to continue…',
  offline: 'Local model is unreachable…',
  private: 'This project is private and this chat’s model isn’t…',
};

export interface ComposerGate {
  block: ComposerBlock | null;
  /** Enter and the Send button may send. */
  canSend: boolean;
  /** The input is disabled and the composer drawn locked. */
  inputLocked: boolean;
  /**
   * The Run button is hidden while idle. A waiting prompt keeps it, since Stop answers the
   * prompt; the offline and private prompts have their own buttons.
   */
  hideIdleRunButton: boolean;
  /** The input's placeholder, or null for the conversation's own. */
  placeholder: string | null;
  title: string;
}

/** Everything the composer derives from its block, so the conditions can't drift apart. */
export function composerGate(block: ComposerBlock | null): ComposerGate {
  return {
    block,
    canSend: block === null,
    inputLocked: block !== null && block !== 'offline' && block !== 'private',
    hideIdleRunButton:
      block === 'connecting' || block === 'restarting' || block === 'offline' || block === 'private',
    placeholder: block ? PLACEHOLDER[block] : null,
    title: block ? PLACEHOLDER[block].replace(/…$/, '') : 'Press Enter to send',
  };
}
