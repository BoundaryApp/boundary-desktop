import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadStackProfile,
  profileToTerraformVars,
  clearProfileCache,
} from '../infrastructure/StackProfileLoader';

describe('StackProfileLoader', () => {
  beforeEach(() => {
    clearProfileCache();
  });

  it('loads runpod-vllm-llama profile', async () => {
    const profile = await loadStackProfile('profiles/runpod-vllm-llama.json');
    expect(profile.dockerImage).toContain('runpod/worker-v1-vllm');
    expect(profile.templateEnv.MODEL_NAME).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(profile.templateEnv.TENSOR_PARALLEL_SIZE).toBe('2');
    expect(profile.template.containerDiskInGb).toBe(200);
    expect(profile.terraform.workers_max).toBe(3);
    expect(profile.terraform.gpu_count).toBe(2);
  });

  it('profileToTerraformVars includes template_id and gpu_count', async () => {
    const profile = await loadStackProfile('profiles/runpod-vllm-llama.json');
    const vars = profileToTerraformVars(profile, 'tpl-abc123');
    expect(vars.template_id).toBe('tpl-abc123');
    expect(vars.endpoint_name).toBe(profile.terraform.endpoint_name);
    expect(vars.gpu_count).toBe(2);
  });
});
