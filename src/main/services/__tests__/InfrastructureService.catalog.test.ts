import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs/promises';
import { InfrastructureService } from '../infrastructure/InfrastructureService';
import { app } from 'electron';
import * as trussRunner from '../infrastructure/TrussRunner';

describe.sequential('InfrastructureService catalog', () => {
  const service = new InfrastructureService();

  beforeEach(async () => {
    const isolatedDir = path.join(os.tmpdir(), `boundary-infra-cat-${randomUUID()}`);
    await fs.mkdir(isolatedDir, { recursive: true });
    // Point userData itself at the isolated dir: every infrastructure path helper derives from it,
    // so stubbing one helper leaves the others writing to the shared mock userData.
    const getPath = app.getPath;
    vi.spyOn(app, 'getPath').mockImplementation((name) =>
      name === 'userData' ? isolatedDir : getPath(name)
    );
    // The real probe spawns Python to see whether Truss could be installed: slow, and
    // dependent on the machine.
    vi.spyOn(trussRunner, 'checkTrussAvailable').mockResolvedValue({ ok: true, command: 'truss' });
  });

  it('createInstance from model and provider sets recipe fields', async () => {
    const res = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'baseten',
    });
    expect(res.success).toBe(true);
    expect(res.instance?.recipeId).toBe('baseten-llama-33-70b');
    expect(res.instance?.provider).toBe('baseten');
    expect(res.instance?.modelId).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(res.instance?.workspacePath).toBeDefined();
  });

  it('legacy stackTypeId creates same recipe as catalog', async () => {
    const legacy = await service.createInstance('runpod-vllm-llama');
    const catalog = await service.createInstance({
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
      provider: 'runpod',
    });
    expect(legacy.success).toBe(true);
    expect(catalog.success).toBe(true);
    expect(legacy.instance?.recipeId).toBe(catalog.instance?.recipeId);
  });

  it('checkPrerequisites requires truss for baseten', async () => {
    const prereq = await service.checkPrerequisites(
      'baseten',
      'meta-llama/Llama-3.3-70B-Instruct'
    );
    expect(prereq.requiresTerraform).toBe(false);
    expect(prereq.requiresTruss).toBe(true);
  });

  it('listCatalog returns models', async () => {
    const models = await service.listCatalog();
    expect(models.some((m) => m.id.includes('Llama'))).toBe(true);
  });
});
