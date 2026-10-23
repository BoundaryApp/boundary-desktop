import type { DeploymentRecipe } from '../../../shared/types/infrastructure';
import { getSecret } from './StackSecretsStore';

/** OpenAI-compatible inference auth (Bearer token). */
export async function getInferenceApiKey(
  instanceId: string,
  recipe: DeploymentRecipe
): Promise<string | null> {
  return getSecret(instanceId, recipe.outputs.authSecret);
}
