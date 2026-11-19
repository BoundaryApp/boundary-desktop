import fs from 'node:fs/promises';
import os from 'node:os';
import { app } from 'electron';
import { reportAsText, type ReportEnvironment } from '../../../shared/bugReport';
import { handle, handleResult } from '../../ipc';
import { readDebugLogTail } from '../../persistDebugLog';
import { pickSavePath } from '../saveDialog';
import { collectReportContext } from './collectReport';
import type { ReportIdentity } from './redactReport';
import { storedSecretValues } from './storedSecrets';

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function reportEnvironment(): ReportEnvironment {
  const darwin = process.platform === 'darwin';
  const version = safe(() => process.getSystemVersion(), '');
  return {
    appVersion: safe(() => app.getVersion(), 'unknown'),
    os: darwin ? `macOS ${version}`.trim() : `${process.platform} ${version}`.trim(),
    chip: darwin ? (process.arch === 'arm64' ? 'Apple silicon' : 'Intel') : process.arch,
  };
}

async function reportIdentity(): Promise<ReportIdentity> {
  return {
    home: os.homedir(),
    host: safe(() => os.hostname(), ''),
    user: safe(() => os.userInfo().username, ''),
    secrets: await storedSecretValues(),
  };
}

export function registerBugReportHandlers(): void {
  handle('bug-report:collect', async () => {
    const identity = await reportIdentity();
    return collectReportContext({
      readLog: () => readDebugLogTail(512_000).contents,
      environment: reportEnvironment,
      identity: () => identity,
    });
  });

  handleResult('bug-report:save', async (event, report) => {
    const path = await pickSavePath(event.sender, {
      title: 'Save Report',
      defaultPath: 'boundary-report.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (!path) return { success: true, saved: false };
    await fs.writeFile(path, reportAsText(report.title, report.body), 'utf8');
    return { success: true, saved: true };
  });
}
