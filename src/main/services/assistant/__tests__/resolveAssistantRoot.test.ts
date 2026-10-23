import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE,
  SOVEREIGN_AGENT_STACK_GITHUB_URL,
} from '../../../../shared/assistantStackConstants';

describe('resolveAssistantRoot', () => {
  const prevEnv = process.env.BOUNDARY_ASSISTANT_ROOT;
  let tmpRoot: string | null = null;

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevEnv;
    }
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it('prefers BOUNDARY_ASSISTANT_ROOT when compose file exists', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-root-'));
    fs.writeFileSync(path.join(tmpRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;

    const { resolveAssistantRoot } = await import('../resolveAssistantRoot');
    expect(resolveAssistantRoot()).toBe(path.resolve(tmpRoot));
  });

  it('throws when BOUNDARY_ASSISTANT_ROOT is missing compose file', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-root-bad-'));
    process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;

    const { resolveAssistantRoot, AssistantRootError } = await import('../resolveAssistantRoot');
    expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
  });

  it('uses userData project when present and does not require sibling assistant', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    const projectRoot = resolveAssistantProjectRoot();
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    tmpRoot = projectRoot;

    const { resolveAssistantRoot } = await import('../resolveAssistantRoot');
    expect(resolveAssistantRoot()).toBe(path.resolve(projectRoot));
  });

  it('error message cites GitHub repo when project missing', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    const projectRoot = resolveAssistantProjectRoot();
    fs.rmSync(projectRoot, { recursive: true, force: true });

    const { resolveAssistantRoot, AssistantRootError } = await import('../resolveAssistantRoot');
    expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
    try {
      resolveAssistantRoot();
    } catch (error) {
      expect(String(error)).toContain(SOVEREIGN_AGENT_STACK_GITHUB_URL);
      expect(String(error)).not.toContain('../assistant');
    }
  });

  it('puts Hermes data under a local stack, not the userData install', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-active-'));
    fs.writeFileSync(path.join(tmpRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;

    const { resolveActiveAssistantDataRoot } = await import('../resolveAssistantRoot');
    expect(resolveActiveAssistantDataRoot()).toBe(path.join(path.resolve(tmpRoot), 'data'));
  });

  it('falls back to the userData install when no stack resolves', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    fs.rmSync(resolveAssistantProjectRoot(), { recursive: true, force: true });

    const { resolveActiveAssistantDataRoot } = await import('../resolveAssistantRoot');
    expect(resolveActiveAssistantDataRoot()).toBe(path.join(resolveAssistantProjectRoot(), 'data'));
  });
});
