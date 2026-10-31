/** Stands in for the provider's name while a model a Circle member shares is the app default. */
export const CIRCLE_MEMBER_PROVIDER = 'a Circle member';

/**
 * What leaves the machine with cloud inference. Shown wherever a user picks or
 * connects a cloud slot; keep it literal (see docs/credential-handling-plan.md).
 */
export function cloudInferenceNotice(provider: string): string {
  if (provider === CIRCLE_MEMBER_PROVIDER) {
    return 'A Circle member’s Mac runs your model. Your messages, and any files, memories or calendar data the agent reads, go to that Mac.';
  }
  return `${provider} runs in the cloud. Your messages, and any files, memories or calendar data the agent reads, go to ${provider} and the model's maker.`;
}

export function cloudKeyLimitTip(provider: string): string {
  return `Set a credit limit on this key in your ${provider} account so a leaked key can't run up a bill.`;
}

/** Short form for tight spots like the chat inference menu. */
export const CLOUD_INFERENCE_SHORT = 'cloud · sees what the agent reads';
