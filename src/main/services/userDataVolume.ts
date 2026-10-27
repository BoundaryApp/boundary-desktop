import { promises as fs, type StatsFs } from 'node:fs';
import os from 'node:os';
import { app } from 'electron';

/** `statfs` of the volume holding Boundary's data: userData, or the home folder before the app is ready. */
export async function userDataVolumeStats(): Promise<StatsFs> {
  let targetPath: string;
  try {
    targetPath = app.getPath('userData');
  } catch {
    targetPath = os.homedir();
  }
  return fs.statfs(targetPath);
}
