import type { HermesChatCredentialRequestEvent } from '../../../shared/types/hermesChat';

type Req = Pick<
  HermesChatCredentialRequestEvent,
  'kind' | 'envVar' | 'prompt' | 'displayName' | 'backend' | 'origin' | 'site' | 'hint'
>;

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
      return 'Password';
  }
}
