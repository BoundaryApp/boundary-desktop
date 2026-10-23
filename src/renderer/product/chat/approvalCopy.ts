import type { HermesChatApprovalEvent } from '../../../shared/types/hermesChat';

const PROTECTED_TOOLS = new Set(['write_file', 'patch', 'edit_file']);

export function approvalKicker(
  event: Pick<HermesChatApprovalEvent, 'toolName' | 'smartDenied'>
): string {
  if (event.smartDenied) {
    return event.toolName
      ? `Reviewer flagged · ${event.toolName}`
      : 'Reviewer flagged';
  }
  return event.toolName
    ? `Approval needed · ${event.toolName}`
    : 'Approval needed';
}

export function approvalWhy(
  event: Pick<
    HermesChatApprovalEvent,
    'toolName' | 'smartDenied' | 'allowSession' | 'allowPermanent' | 'description'
  >
): string {
  if (event.smartDenied) {
    return 'A reviewer marked this as high risk. You can still run it this once, or reject it. It will not be remembered.';
  }
  const tool = (event.toolName ?? '').trim().toLowerCase();
  if (tool === 'execute_code') {
    return 'The agent wrote a script that can run other programs or change files without a second shell check. Approval is for this whole run.';
  }
  if (
    PROTECTED_TOOLS.has(tool) ||
    (event.allowSession === false && event.allowPermanent === false)
  ) {
    return 'This file tells the agent how to work in this folder. Edits are one-shot — they are not saved as a standing permission.';
  }
  return 'The agent wants to run a command that can change files in this folder.';
}

export function approvalAlwaysDescription(): string {
  return 'This adds the pattern to a durable allowlist. The agent will not ask again for commands like this — in this chat or later ones.';
}

export function approvalCommandCollapsed(command: string | undefined): boolean {
  return (command ?? '').length > 280;
}
