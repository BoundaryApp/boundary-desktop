import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localStackFiles } from '../../../stackHost/localStackHost';
import {
  ensureHermesWebuiSyncToInsights,
  resolveHermesWebuiSettingsCandidates,
} from '../hermesWebuiSync';

describe('ensureHermesWebuiSyncToInsights', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDataRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-webui-sync-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'data', 'hermes'), { recursive: true });
    return dir;
  }

  const filesAt = (stackRoot: string) => localStackFiles({ stackRoot, userContentRoot: () => path.join(stackRoot, 'data') });

  it('lists webui and legacy webui-state candidates', () => {
    const paths = resolveHermesWebuiSettingsCandidates();
    expect(paths).toEqual(['hermes/webui/settings.json', 'hermes/webui-state/settings.json']);
  });

  it('creates primary settings.json with sync_to_insights', async () => {
    const stackRoot = makeDataRoot();
    const dataRoot = path.join(stackRoot, 'data');
    const touched = await ensureHermesWebuiSyncToInsights(filesAt(stackRoot));
    expect(touched).toHaveLength(1);
    const primary = path.join(dataRoot, 'hermes', 'webui', 'settings.json');
    expect(fs.existsSync(primary)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(primary, 'utf8')) as {
      sync_to_insights?: boolean;
    };
    expect(parsed.sync_to_insights).toBe(true);
  });

  it('merges into existing settings without clobbering other keys', async () => {
    const stackRoot = makeDataRoot();
    const dataRoot = path.join(stackRoot, 'data');
    const primary = path.join(dataRoot, 'hermes', 'webui', 'settings.json');
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(
      primary,
      JSON.stringify({ theme: 'dark', sync_to_insights: false }, null, 2),
      'utf8'
    );
    const touched = await ensureHermesWebuiSyncToInsights(filesAt(stackRoot));
    expect(touched).toEqual(['hermes/webui/settings.json']);
    const parsed = JSON.parse(fs.readFileSync(primary, 'utf8')) as {
      theme?: string;
      sync_to_insights?: boolean;
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.sync_to_insights).toBe(true);
  });

  it('is a no-op when sync_to_insights is already true', async () => {
    const stackRoot = makeDataRoot();
    const dataRoot = path.join(stackRoot, 'data');
    const primary = path.join(dataRoot, 'hermes', 'webui', 'settings.json');
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(
      primary,
      JSON.stringify({ sync_to_insights: true }, null, 2),
      'utf8'
    );
    expect(await ensureHermesWebuiSyncToInsights(filesAt(stackRoot))).toEqual([]);
  });

  it('updates legacy webui-state settings when present', async () => {
    const stackRoot = makeDataRoot();
    const dataRoot = path.join(stackRoot, 'data');
    const legacy = path.join(dataRoot, 'hermes', 'webui-state', 'settings.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ sync_to_insights: false }), 'utf8');
    const touched = await ensureHermesWebuiSyncToInsights(filesAt(stackRoot));
    expect(touched).toContain('hermes/webui-state/settings.json');
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
      sync_to_insights?: boolean;
    };
    expect(parsed.sync_to_insights).toBe(true);
  });
});
