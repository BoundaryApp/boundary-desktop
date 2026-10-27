import React from 'react';
import type { HermesProjectRecord } from '../../../shared/types/hermesChat';
import { ApprovalInterrupt } from './ApprovalInterrupt';
import { CodingAccessInterrupt } from './CodingAccessInterrupt';
import { CredentialInterrupt } from './CredentialInterrupt';
import { HostBridgeApproval } from './HostBridgeApproval';
import { InfoTip } from '../../components/ui/info-tip';
import { openSettings } from '../settingsNavigation';
import type { ChatInterrupts } from './useChatInterrupts';

/**
 * The one thing above the composer that waits on the user, most urgent first: a credential
 * prompt, a Hermes approval, a host bridge approval, coding-folder access; else the
 * saved-login note or the host-tools note.
 */
export const ThreadInterrupts: React.FC<{
  interrupts: ChatInterrupts;
  projects: HermesProjectRecord[];
  /** Sends a short follow-up turn (coding access granted). */
  onFollowUp: (text: string) => void;
}> = ({ interrupts, projects, onFollowUp }) => {
  const {
    approval,
    chatApprovals,
    credentialRequest,
    credentialRequests,
    savedLogin,
    hostApprovals,
    hostTools,
    codingAccess,
  } = interrupts;
  if (credentialRequest) {
    return (
      <CredentialInterrupt
        request={credentialRequest}
        queueSize={credentialRequests.length + chatApprovals.length}
        busy={interrupts.credentialBusy}
        error={interrupts.credentialError}
        onRespond={(answer) => void interrupts.respondCredential(answer)}
      />
    );
  }
  if (approval) {
    return (
      <ApprovalInterrupt
        approval={approval}
        queueSize={chatApprovals.length}
        busy={interrupts.approvalBusy}
        error={interrupts.approvalError}
        onRespond={(choice) => void interrupts.respondApproval(choice)}
      />
    );
  }
  if (hostApprovals.approval) {
    return (
      <HostBridgeApproval
        approval={hostApprovals.approval}
        queueSize={hostApprovals.queueSize}
        busy={hostApprovals.busy}
        onRespond={(choice) => void hostApprovals.respond(choice)}
      />
    );
  }
  if (codingAccess.request) {
    const request = codingAccess.request;
    return (
      <CodingAccessInterrupt
        request={request}
        projectName={projects.find((project) => project.id === request.projectId)?.name ?? null}
        queueSize={codingAccess.queueSize}
        onResolved={(followUp) => {
          codingAccess.resolve(request);
          // One short, visible turn so Hermes retries in the folder it can now reach.
          if (followUp) onFollowUp(followUp);
        }}
      />
    );
  }
  if (savedLogin) {
    return (
      <div className="wb-saved-login" role="status">
        <span>
          Saved the login for <span className="mono">{savedLogin.site}</span>. The model never saw
          the password.
        </span>
        <button
          type="button"
          className="wb-saved-login-link"
          onClick={() => {
            openSettings({ tab: 'passwords', agentSlug: savedLogin.agentSlug });
            interrupts.dismissSavedLogin();
          }}
        >
          Manage in Passwords &amp; Logins
        </button>
        <button
          type="button"
          className="wb-saved-login-close"
          aria-label="Dismiss"
          onClick={interrupts.dismissSavedLogin}
        >
          ×
        </button>
      </div>
    );
  }
  if (hostTools === 'stopped') {
    return (
      <div className="wb-host-tools-note" role="status">
        Computer access is stopped. Turn it back on in Settings → Computer access.{' '}
        <button
          type="button"
          className="wb-saved-login-link"
          onClick={() => openSettings({ tab: 'access' })}
        >
          Open Computer access
        </button>
      </div>
    );
  }
  if (hostTools === 'waiting' || hostTools === 'off') {
    // Hermes retries a missing MCP server only every few minutes, so the chat can be ready
    // well before Boundary's tools are. Say so rather than let Hermes improvise.
    return (
      <div className="wb-host-tools-note" role="status">
        {hostTools === 'waiting'
          ? "Connecting Hermes to Boundary's tools…"
          : "Boundary's tools aren't running. Restart Boundary to try again."}
        <InfoTip label="Boundary's tools">
          {hostTools === 'waiting'
            ? "Until then Hermes can't send notifications, open links or use your files and clipboard. This usually takes a few seconds, but can take a few minutes on an older stack."
            : "Until they are, Hermes can't send notifications, open links or use your files and clipboard."}
        </InfoTip>
      </div>
    );
  }
  return null;
};
