import { describe, expect, it } from 'vitest';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import type { InferenceProvidersStatus } from '../../../../shared/types/onboarding';
import {
  effectiveInference,
  moveEffects,
  projectCounts,
  projectMarkText,
} from '../projectMove';

const project = (
  id: string,
  name: string,
  inference?: HermesProjectRecord['inference']
): HermesProjectRecord => ({
  id,
  name,
  hostPath: `/Users/ada/${id}`,
  containerPath: `/opt/projects/${id}`,
  slug: id,
  kind: 'host-folder',
  inference,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const local = project('boundary', 'Boundary', { mode: 'local', modelId: 'qwen3-32b' });
const inherits = project('site', 'Landing site', { mode: 'inherit' });
const status: InferenceProvidersStatus = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'openrouter',
  slots: {
    local: { configured: true, modelId: 'qwen3-32b' },
    openrouter: { configured: true, modelId: 'deepseek/deepseek-v3.2' },
  },
};

describe('projectMove (ADR 0024)', () => {
  it('counts filed conversations per project, leaving DMs out', () => {
    expect(
      projectCounts([
        { id: 'a', title: 'a', kind: 'hermes', projectId: 'boundary' },
        { id: 'b', title: 'b', kind: 'channel', projectId: 'boundary' },
        { id: 'c', title: 'c', kind: 'hermes', projectId: null },
        { id: 'd', title: 'd', kind: 'dm', projectId: 'boundary' },
      ])
    ).toEqual({ boundary: 2, none: 1 });
  });

  it('resolves chat override, then the project pin, then the app default', () => {
    expect(effectiveInference(local, null, status)).toMatchObject({ slot: 'local', source: 'project' });
    expect(effectiveInference(inherits, null, status)).toMatchObject({ slot: 'openrouter', source: 'app' });
    expect(
      effectiveInference(inherits, { provider: 'local', modelId: 'qwen3-32b' }, status)
    ).toMatchObject({ slot: 'local', source: 'chat' });
  });

  it('warns when a move sends the chat to the cloud', () => {
    const effects = moveEffects({
      agentName: 'Hermes',
      from: local,
      to: inherits,
      extraSources: 0,
      inferenceBefore: effectiveInference(local, null, status),
      inferenceAfter: effectiveInference(inherits, null, status),
    });
    expect(effects.map((e) => e.kind)).toEqual(['folder', 'sources', 'history', 'cloud']);
    expect(effects[0].text).toContain('~/site');
    expect(effects[3].text).toContain('OpenRouter');
  });

  it("keeps the chat's own override across a move, so nothing about inference changes", () => {
    const override = { provider: 'local' as const, modelId: 'qwen3-32b' };
    const effects = moveEffects({
      agentName: 'Hermes',
      from: local,
      to: inherits,
      inferenceBefore: effectiveInference(local, override, status),
      inferenceAfter: effectiveInference(inherits, override, status),
    });
    expect(effects.at(-1)).toEqual({ kind: 'inference', text: 'Inference stays Local · qwen3-32b.' });
  });

  it('says a move to No project leaves the chat without a folder', () => {
    const effects = moveEffects({
      agentName: 'Hermes',
      from: local,
      to: null,
      inferenceBefore: null,
      inferenceAfter: null,
    });
    expect(effects[0].text).toContain('without a project folder');
  });

  it('writes the transcript line, even after a project is removed', () => {
    const base = { id: 'm', at: '2026-10-04T00:00:00.000Z' };
    expect(
      projectMarkText(
        { ...base, kind: 'moved', fromProjectId: 'boundary', toProjectId: 'site' },
        [local, inherits],
        'Hermes'
      )
    ).toBe('Moved from Boundary to Landing site · ~/site');
    expect(
      projectMarkText(
        { ...base, kind: 'moved', fromProjectId: 'gone', fromName: 'Old', toProjectId: null },
        [local],
        'Hermes'
      )
    ).toBe('Moved from Old to No project');
    expect(
      projectMarkText(
        { ...base, kind: 'folder', fromProjectId: null, toProjectId: 'boundary' },
        [local],
        'Ana'
      )
    ).toBe('Ana now works in Boundary · ~/boundary');
  });
});
