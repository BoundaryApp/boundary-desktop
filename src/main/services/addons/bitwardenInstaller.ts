import type { AddonStepId, BitwardenOverview } from '../../../shared/types/addons';
import { isActualFailure } from '../../../shared/types/addons';
import { BITWARDEN_ENTRY } from './addonCatalog';
import { StepFailed } from './addonRunState';
import { readBitwardenEnabled, type BitwardenService } from './bitwardenAddon';
import { SCRIPT_STEP_OF, createScriptAddonOps, type ScriptAddonDeps, type ScriptAddonRuns } from './scriptAddonInstaller';

// Get, Turn off and Remove and delete data for Bitwarden (spec decisions 26 and 32), through
// `addon.sh`. Get only turns the broker on; the person connects an account in the sheet that
// opens next. Nothing restarts the assistant: `enable` and `disable` run the bootstraps and
// `vault.sh reload-plugins`, and chats started afterwards get the tools.

/** Bitwarden's own `error.step` names, on top of the shared ones. */
const STEP_OF: Record<string, AddonStepId> = { ...SCRIPT_STEP_OF, check: 'disconnect', register: 'disconnect' };

export type BitwardenInstallerDeps = ScriptAddonDeps<BitwardenService>;

export interface BitwardenInstaller extends ScriptAddonRuns {
  install(): Promise<void>;
  /** Disconnects every account Boundary can, then `disable` and `remove --delete-data`. */
  remove(): Promise<void>;
}

export function createBitwardenInstaller(deps: BitwardenInstallerDeps): BitwardenInstaller {
  const ops = createScriptAddonOps({ id: 'bitwarden', name: BITWARDEN_ENTRY.name, stepOf: STEP_OF, deps });
  const { state, check, disable, onLine } = ops;
  const { setStep, markDone } = state;
  const { service } = deps;

  async function runRemoval(overview: BitwardenOverview): Promise<void> {
    const { root } = deps.paths();
    const ours = overview.accounts.filter((a) => a.slug && a.canDisconnect);
    if (ours.length) {
      setStep('disconnect', { status: 'running' });
      for (const account of ours) {
        const result = await service.disconnectUnlocked(account.slug!);
        if (isActualFailure(result) && result.error !== 'not_found') {
          throw new StepFailed('disconnect', `Couldn’t disconnect ${account.slug}: ${result.error}: ${result.message}`, []);
        }
      }
      setStep('disconnect', { status: 'done' });
    }
    setStep('stop', { status: 'running' });
    if (readBitwardenEnabled(root)) await disable('stop');
    setStep('stop', { status: 'done' });
    setStep('delete-data', { status: 'running' });
    check(await deps.run('addon.sh', ['remove', 'bitwarden', '--delete-data', '--json'], { timeoutMs: 600_000 }), 'delete-data');
    const left = overview.accounts.filter((a) => !a.canDisconnect).length;
    setStep('delete-data', {
      status: 'done',
      detail: left ? `${left === 1 ? 'One account' : `${left} accounts`} added at the terminal stayed. Remove them there.` : undefined,
    });
  }

  return {
    install: () =>
      ops.installRun(async (signal) => {
        setStep('start', { status: 'running' });
        check(await service.enable({ onLine }), 'start', signal);
        markDone(['start', 'setup']);
      }),

    cancel: ops.cancel,
    undo: ops.undo,
    start: ops.start,
    turnOff: ops.turnOff,

    remove: () =>
      ops.removeRun(async () => {
        // The accounts as the stack has them now, so every one Boundary can remove is disconnected.
        const overview = await service.refresh();
        const accounts = overview.accounts.some((a) => a.slug && a.canDisconnect);
        return {
          steps: [...(accounts ? (['disconnect'] as const) : []), 'stop', 'delete-data'],
          work: () => runRemoval(overview),
        };
      }),

    snapshot: ops.snapshot,
    onChange: ops.onChange,
  };
}
