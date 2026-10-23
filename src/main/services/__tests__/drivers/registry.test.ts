import { describe, it, expect } from 'vitest';
import { getDriver, getDriverForRecipe, listDrivers } from '../../infrastructure/drivers/registry';
import { getRecipeById } from '../../infrastructure/RecipeLoader';

describe('DriverRegistry', () => {
  it('registers terraform and baseten drivers', () => {
    const kinds = listDrivers().map((d) => d.kind);
    expect(kinds).toContain('terraform');
    expect(kinds).toContain('baseten-truss');
  });

  it('getDriver returns runpod terraform driver', () => {
    const driver = getDriver('terraform');
    expect(driver.requiresTerraform).toBe(true);
  });

  it('getDriverForRecipe resolves from recipe', async () => {
    const recipe = await getRecipeById('baseten-llama-33-70b');
    expect(recipe).toBeDefined();
    const driver = getDriverForRecipe(recipe!);
    expect(driver.kind).toBe('baseten-truss');
    expect(driver.requiresTerraform).toBe(false);
    expect(driver.requiresTruss).toBe(true);
    expect(driver.requiresWorkspace).toBe(true);
  });
});
