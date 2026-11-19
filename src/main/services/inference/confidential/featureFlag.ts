/**
 * Whether the confidential pool is available (ADR 0047). With it on, NEAR AI and Prem use their
 * real adapters, which contact those providers, and other providers use scripted dev stand-ins.
 * It is on for an unpackaged run, and for a packaged one only when asked for at launch.
 */
export function confidentialPoolEnabled(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  const value = env.BOUNDARY_CONFIDENTIAL_POOL;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return !isPackaged;
}
