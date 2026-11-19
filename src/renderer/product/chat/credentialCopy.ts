import type { HermesChatCredentialRequestEvent } from '../../../shared/types/hermesChat';

type Req = Pick<
  HermesChatCredentialRequestEvent,
  | 'kind'
  | 'envVar'
  | 'prompt'
  | 'displayName'
  | 'backend'
  | 'origin'
  | 'site'
  | 'hint'
  | 'identifier'
  | 'regenerate'
  | 'name'
  | 'destination'
  | 'last4'
  | 'replaces'
>;

function keyEnding(req: Req): string {
  return req.last4 ? ` ending in ${req.last4}` : '';
}

export function credentialKicker(req: Req): string {
  switch (req.kind) {
    case 'secret':
      return `Secret needed · ${req.envVar}`;
    case 'vault.unlock_prompt':
      return `Unlock ${req.displayName ?? 'password manager'}`;
    case 'vault.save_login':
      return `Save login · ${req.site ?? req.origin}`;
    case 'vault.code':
      return req.site ? `Code needed · ${req.site}` : 'Code needed';
    case 'vault.create_login':
      return `${req.regenerate ? 'New password' : 'New login'} · ${req.site ?? req.origin}`;
    case 'vault.capture_secret':
      return `Save key · ${req.name}`;
  }
}

export function credentialWhy(req: Req): string {
  switch (req.kind) {
    case 'secret':
      return req.prompt?.trim() || `A skill needs ${req.envVar} to continue.`;
    case 'vault.unlock_prompt':
      return `The agent wants to use logins from ${req.displayName ?? 'your password manager'}.`;
    case 'vault.save_login':
      return `The agent reached a sign-in page at ${req.origin}. Save a login so it can sign in.`;
    case 'vault.code':
      return req.hint?.trim() || 'Enter the one-time code from your device.';
    case 'vault.create_login': {
      const who = req.identifier ? ` as ${req.identifier}` : '';
      return req.regenerate
        ? `${req.site ?? req.origin} didn't accept the password for the account${who}. Approve a new one and the agent fills the form again.`
        : `The agent is signing up at ${req.origin}${who}. Approve a password for the new account and the agent fills the sign-up form.`;
    }
    case 'vault.capture_secret':
      return req.destination === 'env'
        ? `The agent found a key${keyEnding(req)} on ${req.site ?? req.origin} and wants to save it as ${req.name} for its own use.`
        : `The agent wants to hand a key${keyEnding(req)} from ${req.site ?? req.origin} to this app, which can't take keys yet. Decline, then ask the agent to save it for its own use or to tell you where to find it.`;
  }
}

/** Where the value goes. Shown under the inputs; keep it literal. */
export function credentialNote(req: Req): string {
  switch (req.kind) {
    case 'secret':
      return `Saved to this agent's settings as ${req.envVar}. The model only learns whether it was saved.`;
    case 'vault.unlock_prompt':
      return `Your master password goes to ${req.displayName ?? 'the password manager'} to unlock it for this chat. It isn't stored.`;
    case 'vault.save_login':
      return 'Saved in the agent vault and filled only on this exact site. The model never sees the password.';
    case 'vault.code':
      return 'Used once for this sign-in and not stored.';
    case 'vault.create_login':
      return req.regenerate
        ? 'Replaces the password saved for this login in the agent vault. The model never sees it.'
        : 'Saved in the agent vault and filled only on this exact site. The model never sees the password.';
    case 'vault.capture_secret':
      if (req.destination !== 'env') return 'Nothing is saved. The model never sees the key.';
      return req.replaces
        ? `Replaces the ${req.name} this agent already has. The model never sees the key.`
        : `Saved to this agent's settings as ${req.name}. The model never sees the key.`;
  }
}

export function credentialValueLabel(req: Pick<Req, 'kind' | 'envVar'>): string {
  switch (req.kind) {
    case 'secret':
      return req.envVar ?? 'Value';
    case 'vault.unlock_prompt':
      return 'Master password';
    case 'vault.code':
      return 'Code';
    case 'vault.save_login':
    case 'vault.create_login':
      return 'Password';
    case 'vault.capture_secret':
      return 'Key';
  }
}
