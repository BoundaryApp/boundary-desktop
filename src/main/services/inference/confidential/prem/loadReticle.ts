type Reticle = typeof import('@premai/reticle');

let loading: Promise<Reticle> | null = null;

/**
 * Prem's attestation verifier (Rust compiled to WASM). The package reads `reticle_bg.wasm` from
 * its own folder, so it stays external to the bundle and is copied into the packaged app
 * (vite.main.config.ts, forge.config.ts). The first result is cached for the life of the process,
 * and a failed load stays failed until the app restarts.
 */
export function loadReticle(): Promise<Reticle> {
  loading ??= import('@premai/reticle');
  return loading;
}
