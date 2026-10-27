/**
 * Setup for `bun run test:stack`: point Boundary's own resolvers at the stack under test, so
 * resolveHermesStackEndpoints, resolveDashboardCredentials and resolveApiServerKey read it as
 * the app would. Runs after electron-mock-setup (in-memory electron-store).
 */
import { setStoredAssistantPorts } from '../AssistantStackStore';
import { resolveStackTarget } from './stackHarness';

const resolved = resolveStackTarget();
if (resolved.ok) {
  process.env.BOUNDARY_ASSISTANT_ROOT = resolved.target.root;
  setStoredAssistantPorts(resolved.target.ports, resolved.target.isolation);
}
