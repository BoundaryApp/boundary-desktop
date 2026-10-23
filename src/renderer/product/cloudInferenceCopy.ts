/**
 * What leaves the machine with cloud inference. Shown wherever a user picks or
 * connects a cloud slot; keep it literal (see docs/credential-handling-plan.md).
 */
export function cloudInferenceNotice(provider: string): string {
  return `${provider} runs in the cloud. Your messages, and any files, memories or calendar data the agent reads, go to ${provider} and the model's maker.`;
}

export function cloudKeyLimitTip(provider: string): string {
  return `Set a credit limit on this key in your ${provider} account so a leaked key can't run up a bill.`;
}

/** Short form for tight spots like the chat inference menu. */
export const CLOUD_INFERENCE_SHORT = 'cloud · sees what the agent reads';
