import { isEmailSlug, missingSettingsMessage } from '../../../shared/emailAccount';
import { EMAIL_ENTRY } from './addonCatalog';
import { StepFailed } from './addonRunState';
import { readEmailFlags, type EmailService } from './emailAddon';
import { SCRIPT_STEP_OF, createScriptAddonOps, type ScriptAddonDeps, type ScriptAddonRuns } from './scriptAddonInstaller';

// Get, Turn off, Turn on and Remove and delete data for email (stack v0.3.13), through
// `addon.sh`. The account is already saved when Get runs: the sheet saves it and its mailboxes
// first, so Get only turns the add-on on, which starts the indexer on its first pass.
// Nothing restarts the assistant: `enable` and `disable` run the bootstraps and reload the
// plugins, and chats started afterwards get the tools.

export type EmailInstallerDeps = ScriptAddonDeps<EmailService>;

export interface EmailInstaller extends ScriptAddonRuns {
  /**
   * Get: turns email on; the first pass starts in the background. `account` is only validated as
   * a slug: `enable` turns on every saved account, not just this one.
   */
  install(account: string): Promise<void>;
  /** `disable` when on, then `remove email --delete-data`. */
  remove(): Promise<void>;
}

export function createEmailInstaller(deps: EmailInstallerDeps): EmailInstaller {
  const ops = createScriptAddonOps({
    id: 'email',
    name: EMAIL_ENTRY.name,
    stepOf: SCRIPT_STEP_OF,
    deps,
    failureText: (outcome) =>
      outcome.kind === 'error' && outcome.error === 'missing_settings' ? missingSettingsMessage(outcome.message) : null,
  });
  const { state, check, disable, onLine } = ops;
  const { setStep, markDone } = state;
  const { service } = deps;

  async function runRemoval(): Promise<void> {
    setStep('stop', { status: 'running' });
    if (readEmailFlags(deps.paths().root).enabled) await disable('stop');
    setStep('stop', { status: 'done' });
    setStep('delete-data', { status: 'running' });
    check(await deps.run('addon.sh', ['remove', 'email', '--delete-data', '--json'], { timeoutMs: 600_000 }), 'delete-data');
    setStep('delete-data', { status: 'done' });
  }

  return {
    install: (account) => {
      if (!isEmailSlug(account)) return Promise.reject(new Error('Save an account before turning email on.'));
      return ops.installRun(async (signal) => {
        setStep('start', { status: 'running' });
        const outcome = await service.enable({ onLine });
        if (outcome.kind === 'error' && outcome.error === 'missing_settings') {
          throw new StepFailed('start', missingSettingsMessage(outcome.message), outcome.logTail);
        }
        check(outcome, 'start', signal);
        markDone(['start', 'setup']);
      });
    },

    cancel: ops.cancel,
    undo: ops.undo,
    start: ops.start,
    turnOff: ops.turnOff,

    remove: () => ops.removeRun(async () => ({ steps: ['stop', 'delete-data'], work: runRemoval })),

    snapshot: ops.snapshot,
    onChange: ops.onChange,
  };
}
