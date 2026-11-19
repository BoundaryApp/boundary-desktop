import type { ActualBudget, ActualBudgetState, ActualOverview } from '../../../shared/types/addons';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import { useWhenStackReady } from './addonPageActions';

// Actual Budget's connected budgets, shared by the detail page, the store card and the Services
// rail dot. Main reads the stack's index rows, which carry no password or token, and keeps the
// states the last `budget.sh status` run reported. Status runs when the stack becomes ready and
// when Actual's page opens (spec decision 22); nothing polls.

const overview = createIpcStore<ActualOverview | null>({
  initial: null,
  start: () => void reloadActual(),
});

/** Reads the index rows again, without checking any sign-in. */
async function reloadActual(): Promise<void> {
  try {
    overview.set(await window.electronAPI.addons.actual.overview());
  } catch {
    /* keep the last overview */
  }
}

/** Checks every stored sign-in with `budget.sh status`, then shows the result. */
export async function refreshActual(): Promise<void> {
  try {
    overview.set(await window.electronAPI.addons.actual.refresh());
  } catch {
    /* keep the last overview */
  }
}

export function useActualOverview(): ActualOverview | null {
  return useIpcStore(overview);
}

/** Runs `status` each time the stack becomes ready, while this stack has the Actual add-on. */
export function useRefreshActualWhenReady(phase: string, available: boolean): void {
  useWhenStackReady(phase, available, refreshActual);
}

export const budgetName = (b: Pick<ActualBudget, 'slug'>): string => `budget-${b.slug}`;

/** States that need the person: everything but `ok`, not yet checked, and this Mac's server turned off on purpose. */
export function needsAttention(b: ActualBudget): boolean {
  return b.state !== null && b.state !== 'ok' && b.state !== 'server_off';
}

/** Whether any connected budget needs the person, for the Services dot and the Installed list. */
export function useActualAttention(): boolean {
  const current = useActualOverview();
  return Boolean(current?.budgets.some(needsAttention));
}

/** States whose fix is to sign in again (decision 22, plus a stored encryption password that stopped working). */
export function canSignInAgain(state: ActualBudgetState | null): boolean {
  return state === 'token_expired' || state === 'encryption_password';
}

/** The row's line for a state other than `ok` (the phase 7 table, said of a connected budget). */
export function stateMessage(b: Pick<ActualBudget, 'state' | 'server'>): string | null {
  switch (b.state) {
    case null:
    case 'ok':
      return null;
    case 'token_expired':
      return 'That session has ended. Sign in again.';
    case 'no_access':
      return 'This account can’t open that budget any more.';
    case 'encryption_password':
      return 'This budget is encrypted, and the saved encryption password doesn’t open it. Sign in again with it.';
    case 'server_unreachable':
      return `Couldn’t reach ${hostOf(b.server)}. Check that the server is running.`;
    case 'timeout':
      return 'The server didn’t answer within 45 seconds.';
    case 'server_off':
      return 'This Mac’s Actual server is off. Turn it on to use this budget.';
    case 'unknown':
      return 'The stack reported a state Boundary doesn’t know.';
  }
}

/** The server's host for a message: `this Mac’s server` for `local`. */
export function hostOf(server: string): string {
  if (server === 'local') return 'this Mac’s server';
  try {
    return new URL(server).host || server;
  } catch {
    return server;
  }
}

/**
 * What the connect sheet says for each `connect` error (spec, phase 7). An error this build
 * doesn't know reads as a bug and names itself.
 */
export function connectErrorText(error: string, slug: string, server: string): string {
  switch (error) {
    case 'bad_slug':
      return 'Use lowercase letters, numbers and dashes for the name.';
    case 'exists':
      return `budget-${slug} is already connected. Choose another name, or replace it.`;
    case 'login_refused':
      return 'The server didn’t accept that password.';
    case 'token_expired':
      return 'That session has ended. Sign in again.';
    case 'no_access':
      return 'This account can’t open that budget.';
    case 'encryption_password':
      return 'This budget is encrypted. Enter its encryption password.';
    case 'server_unreachable':
      return `Couldn’t reach ${hostOf(server)}. Check the address and that the server is running.`;
    case 'timeout':
      return 'The server didn’t answer within 45 seconds. Try again.';
    default:
      return `Couldn’t connect the budget (${error}).`;
  }
}

/** Opens a budget's server, or this Mac's with `null`. Resolves to a line to show, or null. */
export async function openActual(slug: string | null): Promise<string | null> {
  try {
    const result = await window.electronAPI.addons.actual.open(slug);
    return result.success ? null : (result.error ?? 'Couldn’t open Actual.');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
