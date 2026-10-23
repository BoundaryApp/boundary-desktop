import { contextBridge, ipcRenderer } from 'electron';
import {
  LAG_PROBE_CHANNELS,
  type LagProbeConfig,
  type LagProbeReport,
} from './shared/lagProbe';

// Lag probe bridge (src/shared/lagProbe.ts). Kept apart from electronAPI: it is dev
// instrumentation, and reports are fire-and-forget sends, never invokes.
contextBridge.exposeInMainWorld('boundaryLagProbe', {
  config: (): Promise<LagProbeConfig> => ipcRenderer.invoke(LAG_PROBE_CHANNELS.config),
  report: (report: LagProbeReport) => ipcRenderer.send(LAG_PROBE_CHANNELS.report, report),
  mark: (note?: string) => ipcRenderer.send(LAG_PROBE_CHANNELS.mark, note ?? ''),
});

declare global {
  interface Window {
    boundaryLagProbe?: {
      config: () => Promise<LagProbeConfig>;
      report: (report: LagProbeReport) => void;
      mark: (note?: string) => void;
    };
  }
}
