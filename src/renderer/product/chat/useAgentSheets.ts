import { useCallback, useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import type { ChatLists } from './useChatLists';

type AgentFields = { displayName: string; handle: string; role: string };

/**
 * The agent roster and the create / edit sheet (ADR 0010 §4, ADR 0023). The roster doubles as
 * the DMs plus: "message an agent" lists personalities only.
 */
export function useAgentSheets({
  lists,
  openDm,
}: {
  lists: Pick<ChatLists, 'refreshAgents' | 'setThreadError'>;
  openDm: (agentSlug: string) => Promise<string | null>;
}) {
  const { refreshAgents, setThreadError } = lists;
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rosterMode, setRosterMode] = useState<'roster' | 'message'>('roster');
  const [createOpen, setCreateOpen] = useState(false);
  const sheet = useSheetAction();
  const [createInitial, setCreateInitial] = useState<Partial<AgentFields> | null>(null);
  /** The personality the create sheet is editing (ADR 0010 §4); null when creating. */
  const [editingAgentSlug, setEditingAgentSlug] = useState<string | null>(null);

  // Main answers once the agent is stored and its profile is starting; the DM opens here.
  const createAgent = useCallback(
    async (payload: AgentFields): Promise<boolean> =>
      (await sheet.run(async () => {
        const result = await window.electronAPI.agents.create(payload);
        if (!result.success || !result.agent) {
          sheet.setError(result.error ?? 'Could not create agent.');
          return false;
        }
        await refreshAgents();
        await openDm(result.agent.slug);
        setCreateOpen(false);
        setRosterOpen(false);
        if (result.error) {
          setThreadError(result.error);
        }
        return true;
      })) ?? false,
    [sheet, refreshAgents, openDm, setThreadError]
  );

  const startEdit = useCallback(
    (agent: AgentProfile) => {
      sheet.setError(null);
      setCreateInitial({ displayName: agent.displayName, handle: agent.handle, role: agent.role });
      setEditingAgentSlug(agent.slug);
      setCreateOpen(true);
    },
    [sheet]
  );

  const updateAgent = useCallback(
    async (slug: string, payload: AgentFields) => {
      await sheet.run(async () => {
        const result = await window.electronAPI.agents.update({ slug, ...payload });
        if (!result.success) {
          sheet.setError(result.error ?? 'Could not save the agent.');
          return;
        }
        await refreshAgents();
        setCreateOpen(false);
        setEditingAgentSlug(null);
        if (result.error) {
          setThreadError(result.error);
        } else if (result.soulKept) {
          setThreadError(
            'Saved. Its SOUL.md has your own edits, so the new name and role ' +
              'weren’t written into it.'
          );
        }
      });
    },
    [sheet, refreshAgents, setThreadError]
  );

  /** Creates straight from a draft card; a failure opens the sheet so the error shows (ADR 0010 §6). */
  const createFromDraft = useCallback(
    async (payload: AgentFields) => {
      if (await createAgent(payload)) return;
      setCreateInitial(payload);
      setCreateOpen(true);
    },
    [createAgent]
  );

  return {
    roster: {
      open: rosterOpen,
      mode: rosterMode,
      show: (mode: 'roster' | 'message') => {
        setRosterMode(mode);
        setRosterOpen(true);
      },
      close: () => setRosterOpen(false),
      newAgent: () => {
        setRosterOpen(false);
        setCreateOpen(true);
      },
      openDm: (slug: string) => {
        setRosterOpen(false);
        void openDm(slug);
      },
    },
    create: {
      open: createOpen,
      mode: editingAgentSlug ? ('edit' as const) : ('create' as const),
      busy: sheet.busy,
      // "Starting…" while a create runs; an edit restarts nothing.
      starting: sheet.busy && !editingAgentSlug,
      error: sheet.error,
      initialValues: createInitial,
      cancel: () =>
        sheet.dismiss(() => {
          setCreateOpen(false);
          setCreateInitial(null);
          setEditingAgentSlug(null);
        }),
      submit: (payload: AgentFields) => {
        setCreateInitial(null);
        if (editingAgentSlug) void updateAgent(editingAgentSlug, payload);
        else void createAgent(payload);
      },
    },
    newAgent: () => setCreateOpen(true),
    startEdit,
    createFromDraft: (payload: AgentFields): void => void createFromDraft(payload),
    editDraft: (payload: AgentFields) => {
      setCreateInitial(payload);
      setCreateOpen(true);
    },
  };
}
