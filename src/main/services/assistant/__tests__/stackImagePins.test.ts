import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readImagePins, syncImagePinsFromExample, syncStackImagePins } from '../stackImagePins';

// Shaped like the stack's .env at v0.3.1 and .env.example at v0.3.3.
const OLD_ENV = [
  'NEO4J_PASSWORD=secret',
  'N8N_IMAGE=n8nio/n8n:1.107.4',
  'CALDAV_MCP_IMAGE=ghcr.io/gelse/caldav-mcp:v0.1.0',
  'LIGHTRAG_IMAGE=ghcr.io/hkuds/lightrag:v1.4.9.3',
  'SEARXNG_IMAGE=docker.io/searxng/searxng:2026.8.11-e8e710e42',
  'HERMES_AGENT_IMAGE_TAG=v2026.9.14',
  'HERMES_WEBUI_IMAGE_TAG=0.52.113',
  'HERMES_TERMINAL_BACKEND=ssh',
  '',
].join('\n');

const NEW_EXAMPLE = [
  '### Image pins',
  'N8N_IMAGE=n8nio/n8n:2.43.7',
  'LIGHTRAG_IMAGE=ghcr.io/hkuds/lightrag:v1.5.7',
  'SEARXNG_IMAGE=docker.io/searxng/searxng:2026.8.11-e8e710e42',
  'VIKUNJA_PROXY_IMAGE=nginx:1.30.6-alpine',
  'HERMES_AGENT_IMAGE_TAG=v0.22.2',
  'HERMES_WEBUI_IMAGE_TAG=0.52.458',
  '# IMAGE_PREFIX=assistant',
  '# OPENCODE_IMAGE=commented-out',
  'NEO4J_PASSWORD=change-me',
  '',
].join('\n');

describe('stackImagePins', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads only set image keys', () => {
    expect([...readImagePins(NEW_EXAMPLE).keys()]).toEqual([
      'N8N_IMAGE',
      'LIGHTRAG_IMAGE',
      'SEARXNG_IMAGE',
      'VIKUNJA_PROXY_IMAGE',
      'HERMES_AGENT_IMAGE_TAG',
      'HERMES_WEBUI_IMAGE_TAG',
    ]);
  });

  it('moves every image pin to the example and drops retired ones', () => {
    const next = syncImagePinsFromExample(OLD_ENV, NEW_EXAMPLE);
    const pins = readImagePins(next);
    expect(pins.get('N8N_IMAGE')).toBe('n8nio/n8n:2.43.7');
    expect(pins.get('LIGHTRAG_IMAGE')).toBe('ghcr.io/hkuds/lightrag:v1.5.7');
    expect(pins.get('HERMES_AGENT_IMAGE_TAG')).toBe('v0.22.2');
    expect(pins.get('HERMES_WEBUI_IMAGE_TAG')).toBe('0.52.458');
    expect(pins.get('VIKUNJA_PROXY_IMAGE')).toBe('nginx:1.30.6-alpine');
    expect(pins.has('CALDAV_MCP_IMAGE')).toBe(false);
    expect(pins.has('OPENCODE_IMAGE')).toBe(false);
    // Secrets and other settings are left alone.
    expect(next).toContain('NEO4J_PASSWORD=secret\n');
    expect(next).toContain('HERMES_TERMINAL_BACKEND=ssh\n');
    expect(syncImagePinsFromExample(next, NEW_EXAMPLE)).toBe(next);
  });

  it('changes nothing when the example has no image pins', () => {
    expect(syncImagePinsFromExample(OLD_ENV, 'NEO4J_PASSWORD=x\n')).toBe(OLD_ENV);
  });

  it('rewrites the project .env and reports whether it changed', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-pins-'));
    fs.writeFileSync(path.join(dir, '.env'), OLD_ENV);
    fs.writeFileSync(path.join(dir, '.env.example'), NEW_EXAMPLE);
    expect(await syncStackImagePins(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('HERMES_AGENT_IMAGE_TAG=v0.22.2');
    expect(await syncStackImagePins(dir)).toBe(false);
  });
});
