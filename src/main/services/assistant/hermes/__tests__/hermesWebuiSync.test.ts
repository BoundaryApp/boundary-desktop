import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    fs.mkdirSync(path.join(dir, 'hermes'), { recursive: true });
    return dir;
  }

  it('lists webui and legacy webui-state candidates', () => {
    const dataRoot = makeDataRoot();
    const paths = resolveHermesWebuiSettingsCandidates(dataRoot);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(path.join('hermes', 'webui', 'settings.json'));
    expect(paths[1]).toContain(path.join('hermes', 'webui-state', 'settings.json'));
  });

  it('creates primary settings.json with sync_to_insights', () => {
    const dataRoot = makeDataRoot();
    const touched = ensureHermesWebuiSyncToInsights(dataRoot);
    expect(touched).toHaveLength(1);
    const primary = path.join(dataRoot, 'hermes', 'webui', 'settings.json');
    expect(fs.existsSync(primary)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(primary, 'utf8')) as {
      sync_to_insights?: boolean;
    };
    expect(parsed.sync_to_insights).toBe(true);
  });

  it('merges into existing settings without clobbering other keys', () => {
    const dataRoot = makeDataRoot();
    const primary = path.join(dataRoot, 'hermes', 'webui', 'settings.json');
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(
      primary,
      JSON.stringify({ theme: 'dark', sync_to_insights: false }, null, 2),
      'utf8'
    );
    const touched = ensureHermesWebuiSyncToInsights(dataRoot);
    expect(touched).toEqual([primary]);
    const parsed = JSON.parse(fs.readFileSync(primary, 'utf8')) as {
      theme?: string;
      sync_to_insights?: boolean;
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.sync_to_insights).toBe(true);
  });

  it('is a no-op when sync_to_insights is already true', () => {
    const dataRoot = makeDataRoot();
    const primary = path.join(dataRoot, 'hermes', 'webui', 'settings.json');
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(
      primary,
      JSON.stringify({ sync_to_insights: true }, null, 2),
      'utf8'
    );
    expect(ensureHermesWebuiSyncToInsights(dataRoot)).toEqual([]);
  });

  it('updates legacy webui-state settings when present', () => {
    const dataRoot = makeDataRoot();
    const legacy = path.join(dataRoot, 'hermes', 'webui-state', 'settings.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ sync_to_insights: false }), 'utf8');
    const touched = ensureHermesWebuiSyncToInsights(dataRoot);
    expect(touched).toContain(legacy);
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
      sync_to_insights?: boolean;
    };
    expect(parsed.sync_to_insights).toBe(true);
  });
});
