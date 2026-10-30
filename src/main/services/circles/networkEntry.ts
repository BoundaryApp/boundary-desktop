import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The network utilityProcess, bundled next to the main bundle (vite.circlesNetwork.config.ts). */
export const NETWORK_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'circlesNetwork.js');
