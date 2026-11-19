import { useCallback, useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import type { AgentWritingVoices } from '../../../shared/types/writingVoices';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import type { ChatLists } from './useChatLists';

type AgentFields = { displayName: string; handle: string; role: string; voices?: AgentWritingVoices };

const sameVoices = (a: AgentWritingVoices, b: AgentWritingVoices) =>
  a.chatRepliesVoiceId === b.chatRepliesVoiceId && a.draftsVoiceId === b.draftsVoiceId;

const NO_VOICES: AgentWritingVoices = { chatRepliesVoiceId: null, draftsVoiceId: null };

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

  /** Voices are saved after the agent itself; a failure is the chat's note, not the sheet's. */
  const saveVoices = useCallback(
    async (slug: string, voices: AgentWritingVoices | undefined, before: AgentWritingVoices) => {
      if (!voices || sameVoices(voices, before)) return;
      const result = await window.electronAPI.agents.setWritingVoices(slug, voices);
      if ('error' in result) setThreadError(result.error);
    },
    [setThreadError]
  );
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rosterMode, setRosterMode] = useState<'roster' | 'message'>('roster');
  const [createOpen, setCreateOpen] = useState(false);
  const sheet = useSheetAction();
  const [createInitial, setCreateInitial] = useState<Partial<AgentFields> | null>(null);
  /** The personality the create sheet is editing (ADR 0010 §4); null when creating. */
  const [editingAgentSlug, setEditingAgentSlug] = useState<string | null>(null);
  /** The edited agent's voices when the sheet opened, so only a change is saved. */
  const [editingVoices, setEditingVoices] = useState<AgentWritingVoices>(NO_VOICES);

  // Main answers once the agent is stored and its profile is starting; the DM opens here.
  const createAgent = useCallback(
    async (payload: AgentFields): Promise<boolean> =>
      (await sheet.run(async () => {
        const { voices, ...fields } = payload;
        const result = await window.electronAPI.agents.create(fields);
        if (!result.success || !result.agent) {
          sheet.setError(result.error ?? 'Could not create agent.');
          return false;
        }
        await saveVoices(result.agent.slug, voices, NO_VOICES);
        await refreshAgents();
        await openDm(result.agent.slug);
        setCreateOpen(false);
        setRosterOpen(false);
        if (result.error) {
          setThreadError(result.error);
        }
        return true;
      })) ?? false,
    [sheet, refreshAgents, openDm, setThreadError, saveVoices]
  );

  const startEdit = useCallback(
    (agent: AgentProfile) => {
      sheet.setError(null);
      setCreateInitial({
        displayName: agent.displayName,
        handle: agent.handle,
        role: agent.role,
        voices: {
          chatRepliesVoiceId: agent.chatRepliesVoiceId ?? null,
          draftsVoiceId: agent.draftsVoiceId ?? null,
        },
      });
      setEditingVoices({
        chatRepliesVoiceId: agent.chatRepliesVoiceId ?? null,
        draftsVoiceId: agent.draftsVoiceId ?? null,
      });
      setEditingAgentSlug(agent.slug);
      setCreateOpen(true);
    },
    [sheet]
  );

  const updateAgent = useCallback(
    async (slug: string, payload: AgentFields) => {
      await sheet.run(async () => {
        const { voices, ...fields } = payload;
        const result = await window.electronAPI.agents.update({ slug, ...fields });
        if (!result.success) {
          sheet.setError(result.error ?? 'Could not save the agent.');
          return;
        }
        await saveVoices(slug, voices, editingVoices);
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
    [sheet, refreshAgents, setThreadError, saveVoices, editingVoices]
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
