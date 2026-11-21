import type {
  AgentProfile,
  ChannelRecord,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';
import { displayHostPath } from './chatTelemetryFormat';
import { ProjectGlyph } from './ProjectGlyph';
import { AgentMark } from './ConversationMark';
import { InfoTip } from '../../components/ui/info-tip';
import { Button } from '../../components/ui/button';

export function RoomPane({
  channel,
  agents,
  project,
  onOpenProject,
  onAddMember,
  onRemoveMember,
}: {
  channel: ChannelRecord;
  agents: AgentProfile[];
  project: HermesProjectRecord | null;
  onOpenProject: () => void;
  onAddMember?: (agentSlug: string) => void;
  onRemoveMember?: (agentSlug: string) => void;
}) {
  // Built-in first, then everyone else not already in the room.
  const addable = agents
    .filter((a) => !channel.memberSlugs.includes(a.slug))
    .sort((a, b) => Number(b.builtIn) - Number(a.builtIn));
  return (
    <div className="wb-insp-pane">
      <div className="wb-insp-ident">
        <span>
          <span className="who-name">#{channel.slug}</span>
          <span className="who-meta">
            {channel.memberSlugs.length}{' '}
            {channel.memberSlugs.length === 1 ? 'member' : 'members'} · posts stay in the
            room
          </span>
        </span>
      </div>
      <div className="wb-src-hed">
        <span>
          Members
          <InfoTip label="room members">
            Members read the room’s posts later. @ someone to ask them to answer now.
          </InfoTip>
        </span>
      </div>
      <div className="wb-members">
        {channel.memberSlugs.length === 0 ? (
          <p className="wb-empty">No members yet. Add one below to @ them.</p>
        ) : (
          channel.memberSlugs.map((slug) => {
            const member = agents.find((a) => a.slug === slug);
            const name = member?.displayName ?? slug;
            return (
              <div key={slug} className="wb-member-row">
                <AgentMark agent={{ slug, displayName: name, builtIn: member?.builtIn }} />
                <span className="wb-member-copy">
                  <span className="name" title={name}>
                    {name}
                  </span>
                  {member?.builtIn ? <span className="sub">Default agent</span> : null}
                </span>
                {onRemoveMember ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    className="wb-member-remove"
                    aria-label={`Remove ${name} from #${channel.slug}`}
                    title={`Remove ${name} from #${channel.slug}`}
                    onClick={() => onRemoveMember(slug)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {onAddMember && addable.length > 0 ? (
        <div className="wb-member-add" role="group" aria-label="Add a member">
          <span className="wb-member-add-label">Add</span>
          {addable.map((agent) => (
            <Button
              variant="secondary"
              size="sm"
              key={agent.slug}
              type="button"
              aria-label={`Add ${agent.displayName} to #${channel.slug}`}
              onClick={() => onAddMember(agent.slug)}
            >
              <AgentMark agent={agent} size={14} />
              {agent.displayName}
            </Button>
          ))}
        </div>
      ) : null}
      {project ? (
        <button
          type="button"
          className="wb-insp-bind"
          title={`${project.name} · ${displayHostPath(project.hostPath)}`}
          onClick={onOpenProject}
        >
          <ProjectGlyph project={project} />
          <span>
            <span className="name">{project.name}</span>
            <span className="path mono">{displayHostPath(project.hostPath)}</span>
          </span>
          <span className="go">Project →</span>
        </button>
      ) : null}
    </div>
  );
}
