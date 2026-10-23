import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllManifests, clearManifestCache, getManifestById } from '../infrastructure/StackManifestLoader';

describe('StackManifestLoader', () => {
  beforeEach(() => {
    clearManifestCache();
  });

  it('loads runpod-vllm-llama manifest with profile and two secrets', async () => {
    const manifests = await loadAllManifests();
    expect(manifests.length).toBeGreaterThan(0);
    const runpod = manifests.find((m) => m.id === 'runpod-vllm-llama');
    expect(runpod).toBeDefined();
    expect(runpod?.profilePath).toBe('profiles/runpod-vllm-llama.json');
    expect(runpod?.variables).toHaveLength(2);
    expect(runpod?.variables.every((v) => v.sensitive)).toBe(true);
    expect(runpod?.variables.some((v) => v.name === 'runpod_api_key')).toBe(true);
    expect(runpod?.variables.some((v) => v.name === 'hf_token' && v.required)).toBe(true);
    expect(runpod?.variables.some((v) => v.name === 'template_id')).toBe(false);
  });

  it('getManifestById returns null for unknown id', async () => {
    const m = await getManifestById('nonexistent-stack');
    expect(m).toBeNull();
  });
});
