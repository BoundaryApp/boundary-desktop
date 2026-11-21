import { STACK_CAPABILITY_MISSING_TEXT, type StackCapability } from '../../../shared/stackCapabilities';

/** Thrown by a feature its stack host can't run; the message is what the feature shows. */
export class StackCapabilityMissing extends Error {
  readonly capability: StackCapability;

  constructor(capability: StackCapability) {
    super(STACK_CAPABILITY_MISSING_TEXT[capability]);
    this.name = 'StackCapabilityMissing';
    this.capability = capability;
  }
}
