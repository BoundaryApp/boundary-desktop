import type { StepLook } from '../components/ui/step-list';
import type {
  RuntimeProvisionSnapshot,
  RuntimeProvisionStage,
} from '../../shared/types/capability';
import { APP_NAME } from '../../shared/buildIdentity';
import { SLOW_STAGE_MS } from '../product/startup/startupModel';

/**
 * The rows of setup's Preparing screen: the container runtime resolve's stages, then the
 * memory, CPU and disk checks that follow it.
 */
export type PreparingRowId = Exclude<RuntimeProvisionStage, 'ready'> | 'checks';

export interface PreparingRow {
  id: PreparingRowId;
  look: StepLook;
  name: string;
  detail: string;
  /** Epoch ms the row began, on the running row only. */
  startedAt?: number;
}

const ENGINE_STAGES: readonly RuntimeProvisionStage[] = ['configure', 'create', 'start', 'connect'];

/** Creating the machine has its own wait in its detail, so its slow hint comes later. */
const CREATE_SLOW_MS = 5 * 60_000;

function usesEngine(snapshot: RuntimeProvisionSnapshot): boolean {
  return snapshot.reached.some((stage) => ENGINE_STAGES.includes(stage));
}

function rowText(id: PreparingRowId, engine: boolean): { name: string; detail: string } {
  switch (id) {
    case 'docker':
      return {
        name: 'Look for Docker',
        detail: engine
          ? `Docker isn’t running, so ${APP_NAME} uses its own container engine`
          : 'Uses Docker Desktop if it’s running',
      };
    case 'configure':
      return { name: 'Set up the container engine', detail: 'Where your assistant’s tools will run' };
    case 'create':
      return {
        name: 'Create the engine',
        detail: 'A small Linux virtual machine. First launch only, and it takes a few minutes',
      };
    case 'start':
      return { name: 'Start the engine', detail: 'Boots the virtual machine' };
    case 'connect':
      return { name: 'Wait for the engine to answer', detail: 'Checks that it accepts commands' };
    case 'checks':
      return { name: 'Check memory, CPU and disk', detail: 'Makes sure this Mac can run your assistant' };
  }
}

/**
 * The rows for a resolve. The engine rows appear once the resolve falls back to the bundled
 * engine, and Create only when the machine is being made. Rows before the current one are done.
 */
export function preparingRows(snapshot: RuntimeProvisionSnapshot): PreparingRow[] {
  const engine = usesEngine(snapshot);
  const ids: PreparingRowId[] = ['docker'];
  if (engine) {
    ids.push('configure');
    if (snapshot.reached.includes('create')) ids.push('create');
    ids.push('start', 'connect');
  }
  ids.push('checks');
  const currentId: PreparingRowId = snapshot.stage === 'ready' ? 'checks' : snapshot.stage;
  const current = ids.indexOf(currentId);
  return ids.map((id, index) => ({
    id,
    ...rowText(id, engine),
    look: index < current ? 'done' : index === current ? 'run' : 'pending',
    ...(index === current ? { startedAt: snapshot.stageStartedAt } : {}),
  }));
}

/** True when the running row has gone on long enough to say so. */
export function preparingRowSlow(row: PreparingRow, now: number): boolean {
  if (row.look !== 'run' || row.startedAt === undefined) return false;
  return now - row.startedAt >= (row.id === 'create' ? CREATE_SLOW_MS : SLOW_STAGE_MS);
}

export function preparingDescription(snapshot: RuntimeProvisionSnapshot): string {
  return usesEngine(snapshot)
    ? 'The first launch sets up the container engine your assistant runs in. Later launches are quicker.'
    : `${APP_NAME} is checking this Mac before setup.`;
}
