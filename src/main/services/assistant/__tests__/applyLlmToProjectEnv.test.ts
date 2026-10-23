import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyLlmConnectionToProjectFiles,
  clearLlmKeysFromProjectEnv,
  __test,
} from '../applyLlmToProjectEnv';

describe('applyLlmToProjectEnv', () => {
  let tmpRoot: string | null = null;

  afterEach(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it('upserts env keys without duplicating', () => {
    let contents = 'LLM_MODEL=old\nOTHER=1\n';
    contents = __test.upsertEnvLine(contents, 'LLM_MODEL', 'new-model');
    contents = __test.upsertEnvLine(contents, 'LLM_BINDING', 'openai');
    expect(contents).toMatch(/^LLM_MODEL=new-model$/m);
    expect(contents).toMatch(/^LLM_BINDING=openai$/m);
    expect(contents.match(/LLM_MODEL=/g)?.length).toBe(1);
  });

  it('removes whole lines for the given keys only', () => {
    const out = __test.removeEnvLines('A=1\nOPENAI_API_KEY=x\n# OPENAI_API_KEY=y\nB=2', [
      'OPENAI_API_KEY',
    ]);
    expect(out).toBe('A=1\n# OPENAI_API_KEY=y\nB=2');
  });

  it('blanks upstream keys an older version left in .env', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-llm-env-'));
    const envPath = path.join(tmpRoot, '.env');
    fs.writeFileSync(
      envPath,
      'LLM_BINDING_API_KEY=sk-real\nLIGHTRAG_LLM_BINDING_API_KEY=sk-real\n' +
        'EMBEDDING_BINDING_API_KEY=embed-key\n'
    );
    expect(await clearLlmKeysFromProjectEnv(tmpRoot)).toBe(true);
    const env = fs.readFileSync(envPath, 'utf8');
    expect(env).not.toContain('sk-real');
    expect(env).toMatch(/^LLM_BINDING_API_KEY=$/m);
    expect(env).toMatch(/^LIGHTRAG_LLM_BINDING_API_KEY=$/m);
    expect(env).toMatch(/^EMBEDDING_BINDING_API_KEY=embed-key$/m);
    // Already blank: nothing to do, so no proxy recreate.
    expect(await clearLlmKeysFromProjectEnv(tmpRoot)).toBe(false);
  });

  it('writes the key and keeps retired lines in a local stack checkout', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-llm-env-'));
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'OPENAI_API_KEY=keep-me\nFAST_LLM=openai:x\n');
    await applyLlmConnectionToProjectFiles(
      tmpRoot,
      { endpointUrl: 'http://127.0.0.1:1234/v1', apiKey: 'k', modelId: 'm' },
      { localStack: true }
    );
    const env = fs.readFileSync(path.join(tmpRoot, '.env'), 'utf8');
    // The developer's stack isn't driven by Boundary, so it reads the key from .env.
    expect(env).toMatch(/^LLM_BINDING_API_KEY=k$/m);
    expect(env).toMatch(/^OPENAI_API_KEY=keep-me$/m);
    expect(env).toMatch(/^FAST_LLM=openai:x$/m);
    expect(env).toMatch(/^LLM_MODEL=m$/m);
  });

  it('writes .env and opencode.local.json from Boundary LLM', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-llm-env-'));
    fs.mkdirSync(path.join(tmpRoot, 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.env'),
      'LLM_MODEL=your-chat-model\nLLM_BINDING_HOST=http://host.docker.internal:1234/v1\n' +
        'OPENAI_API_KEY=old-real-key\nFAST_LLM=openai:old\nKEEP=1\n'
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'local/your-chat-model',
        provider: {
          local: {
            options: { baseURL: 'http://host.docker.internal:1234/v1' },
            models: {},
          },
        },
      })
    );

    await applyLlmConnectionToProjectFiles(tmpRoot, {
      endpointUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'test-key',
      modelId: 'gpt-test',
    });

    const env = fs.readFileSync(path.join(tmpRoot, '.env'), 'utf8');
    expect(env).toMatch(/LLM_MODEL=gpt-test/);
    expect(env).toMatch(/LLM_BINDING_HOST=http:\/\/host\.docker\.internal:1234\/v1/);
    // The key goes to llm-proxy through its admin API, never into .env.
    expect(env).toMatch(/^LLM_BINDING_API_KEY=$/m);
    expect(env).toMatch(/^LIGHTRAG_LLM_BINDING_API_KEY=$/m);
    expect(env).not.toContain('test-key');
    // Retired keys are removed, including the stale copy of a real key.
    expect(env).not.toMatch(/OPENAI_API_KEY|FAST_LLM|SMART_LLM|STRATEGIC_LLM|OPENAI_BASE_URL/);
    expect(env).not.toContain('old-real-key');
    expect(env).toMatch(/^KEEP=1$/m);

    // OpenCode goes through llm-proxy with a placeholder; the real key isn't in its config.
    const raw = fs.readFileSync(path.join(tmpRoot, 'opencode', 'opencode.local.json'), 'utf8');
    const opencode = JSON.parse(raw) as {
      model: string;
      provider: { local: { options: { baseURL: string; apiKey: string } } };
    };
    expect(opencode.model).toBe('local/gpt-test');
    expect(opencode.provider.local.options.baseURL).toBe('http://llm-proxy:4000/v1');
    expect(opencode.provider.local.options.apiKey).toBe('local-llm');
    expect(raw).not.toContain('test-key');
  });
});
