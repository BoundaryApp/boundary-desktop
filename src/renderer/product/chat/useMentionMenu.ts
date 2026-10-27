import React, { useCallback, useEffect, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type {
  AgentProfile,
  ChannelRecord,
  HermesCompletePathItem,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';

export type MentionItem =
  | (HermesCompletePathItem & { kind: 'file' })
  | {
      kind: 'agent';
      text: string;
      display: string;
      meta: string;
      agentSlug: string;
      builtIn: boolean;
      notInChannel?: boolean;
    };

/** Where the mention being typed starts: the last `@`, when it starts a word; else -1. */
function mentionStart(text: string): number {
  const at = text.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(text[at - 1] ?? ''))) return -1;
  return at;
}

/** Text after the last `@` that starts a word, or null when no mention is being typed. */
function mentionQueryFor(text: string): string | null {
  const at = mentionStart(text);
  return at < 0 ? null : text.slice(at + 1);
}

/**
 * The @ menu: agents (a room's members first), then files in the project. Opens while an `@`
 * that starts a word is being typed, or from the @ chip.
 */
export function useMentionMenu({
  inputRef,
  agents,
  channel,
  isChannel,
  activeProject,
  sessionId,
  onAddChannelMember,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  agents: AgentProfile[];
  channel: ChannelRecord | null;
  isChannel: boolean;
  activeProject: HermesProjectRecord | null;
  sessionId: string | null;
  onAddChannelMember?: (agentSlug: string) => Promise<boolean>;
}) {
  const aui = useAui();
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Read from the store with a narrow selector, never mirrored from input events: a state
  // update inside the input event resets the textarea's DOM value and moves the caret.
  const typedMentionQuery = useAuiState((s) => mentionQueryFor(s.composer.text));

  useEffect(() => {
    setMentionOpen(typedMentionQuery !== null);
    setMentionQuery(typedMentionQuery ?? '');
  }, [typedMentionQuery]);

  useEffect(() => {
    if (!mentionOpen) {
      setMentionItems([]);
      setMentionIndex(0);
      return;
    }
    let cancelled = false;
    const q = mentionQuery.trim().toLowerCase();

    const matchesQuery = (a: AgentProfile) => {
      if (!q) return true;
      return (
        a.displayName.toLowerCase().includes(q) ||
        a.handle.toLowerCase().includes(q) ||
        a.slug.toLowerCase().includes(q)
      );
    };

    let agentHits: MentionItem[] = [];
    if (isChannel && channel) {
      const members = agents.filter(
        (a) => channel.memberSlugs.includes(a.slug) && matchesQuery(a)
      );
      const nonMembers = agents.filter(
        (a) => !channel.memberSlugs.includes(a.slug) && matchesQuery(a)
      );
      agentHits = [
        ...members.slice(0, 6).map((a) => ({
          kind: 'agent' as const,
          text: a.displayName,
          display: a.displayName,
          meta: a.builtIn ? 'Default agent · member · address now' : 'Member · address now',
          agentSlug: a.slug,
          builtIn: Boolean(a.builtIn),
        })),
        ...nonMembers.slice(0, 4).map((a) => ({
          kind: 'agent' as const,
          text: a.displayName,
          display: a.displayName,
          meta: a.builtIn
            ? 'Default agent · not in channel · add to let it read'
            : 'Not in channel · add to let them read',
          agentSlug: a.slug,
          builtIn: Boolean(a.builtIn),
          notInChannel: true,
        })),
      ];
    } else {
      agentHits = agents
        .filter(matchesQuery)
        .slice(0, 6)
        .map((a) => ({
          kind: 'agent' as const,
          text: a.displayName,
          display: a.displayName,
          meta: a.builtIn ? 'Default agent' : a.role,
          agentSlug: a.slug,
          builtIn: Boolean(a.builtIn),
        }));
    }

    if (!activeProject) {
      setMentionItems(agentHits);
      setMentionIndex(0);
      return;
    }

    const handle = window.setTimeout(() => {
      void window.electronAPI.projects
        .completePath({
          word: mentionQuery,
          cwd: activeProject.containerPath,
          sessionId: sessionId ?? undefined,
        })
        .then((result) => {
          if (cancelled) return;
          const files: MentionItem[] = (result.success ? result.items : [])
            .slice(0, 8)
            .map((item) => ({
              ...item,
              kind: 'file' as const,
            }));
          setMentionItems([...agentHits, ...files]);
          setMentionIndex(0);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mentionOpen, mentionQuery, activeProject, sessionId, agents, isChannel, channel]);

  const applyMention = useCallback(
    (item: MentionItem) => {
      // Read the composer store — inputRef.value can be empty on click (blur).
      const value = aui.composer.getState().text;
      const at = mentionStart(value);
      if (at < 0) return;
      const insert = item.text;
      const next = `${value.slice(0, at)}@${insert} `;
      aui.composer.setText(next);
      setMentionOpen(false);
      setMentionQuery('');
      inputRef.current?.focus();
      const el = inputRef.current;
      if (el) {
        const caret = next.length;
        el.setSelectionRange(caret, caret);
      }
    },
    [aui, inputRef]
  );

  const insertMention = useCallback(
    (item: MentionItem) => {
      // Choosing someone not in the room adds them, then mentions them (ADR 0010 §5).
      if (item.kind === 'agent' && item.notInChannel && item.agentSlug && onAddChannelMember) {
        setMentionOpen(false);
        void onAddChannelMember(item.agentSlug).then((added) => {
          if (added) applyMention(item);
        });
        return;
      }
      applyMention(item);
    },
    [applyMention, onAddChannelMember]
  );

  const handleMentionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mentionOpen || mentionItems.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionItems.length) % mentionItems.length
        );
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionOpen(false);
        setMentionQuery('');
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const item = mentionItems[mentionIndex] ?? mentionItems[0];
        if (item) insertMention(item);
      }
    },
    [insertMention, mentionIndex, mentionItems, mentionOpen]
  );

  /** The @ chip: types the @ too, since choosing from the list replaces the typed @. */
  const openFromChip = useCallback(() => {
    const value = aui.composer.getState().text;
    if (mentionQueryFor(value) !== '') {
      aui.composer.setText(value === '' || /\s$/.test(value) ? `${value}@` : `${value} @`);
    }
    setMentionOpen(true);
    setMentionQuery('');
    inputRef.current?.focus();
  }, [aui, inputRef]);

  return {
    /** Whether the list is showing (open with something to choose). */
    showing: mentionOpen && mentionItems.length > 0,
    items: mentionItems,
    index: mentionIndex,
    insertMention,
    handleMentionKeyDown,
    openFromChip,
  };
}
