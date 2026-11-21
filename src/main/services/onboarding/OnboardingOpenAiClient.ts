import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { postChatCompletion } from './endpointVerification';
import { getLlmConnection, getSlotLlmConnection } from './OpenAiOnboardingStore';

export async function sendOnboardingTestMessage(
  message: string,
  slot?: InferenceSlotId
): Promise<{ success: boolean; content?: string; error?: string }> {
  const connection = slot ? await getSlotLlmConnection(slot) : await getLlmConnection();
  if (!connection) {
    return { success: false, error: 'No LLM connection is configured.' };
  }

  const result = await postChatCompletion(
    { ...connection, baseUrl: connection.endpointUrl },
    { modelId: connection.modelId, message }
  );
  return result.ok
    ? { success: true, content: result.content }
    : { success: false, error: result.error };
}
