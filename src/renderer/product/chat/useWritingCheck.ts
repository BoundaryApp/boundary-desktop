import { useCallback, useState } from 'react';
import type { WritingCheckFileResult } from '../../../shared/types/writingCheck';
import type { WritingCheckRequest } from './WritingCheckPane';

/** How long "Show in chat" marks the checked reply. */
const FOCUS_MS = 2400;

/**
 * The chat screen's writing check (writing check spec, phase 2): the reply last sent to the
 * inspector's Check tab, for the conversation it came from. Opening another conversation hides
 * it; coming back before another check shows it again.
 */
export function useWritingCheck(conversationKey: string) {
  const [state, setState] = useState<{ key: string; check: WritingCheckRequest } | null>(null);

  const request = useCallback(
    (check: Omit<WritingCheckRequest, 'seq'>) =>
      setState((previous) => ({
        key: conversationKey,
        check: { ...check, seq: (previous?.check.seq ?? 0) + 1 },
      })),
    [conversationKey]
  );

  const close = useCallback(() => setState(null), []);

  /** Shows a file's result, or why it couldn't be read; a cancelled pick changes nothing. */
  const showFile = useCallback(
    (projectId: string, fallbackPath: string, result: WritingCheckFileResult) => {
      if (result.canceled) return;
      if (result.success && result.file) {
        const { relativePath, text, modifiedAt } = result.file;
        request({
          messageId: '',
          markdown: text,
          source: relativePath,
          file: { projectId, relativePath, modifiedAt },
        });
        return;
      }
      request({
        messageId: '',
        markdown: '',
        source: fallbackPath || 'File',
        error: result.error ?? 'Could not read the file.',
        ...(fallbackPath ? { file: { projectId, relativePath: fallbackPath, modifiedAt: '' } } : {}),
      });
    },
    [request]
  );

  /** A file the agent wrote, or Check again: main reads it inside the project folder. */
  const checkFile = useCallback(
    async (projectId: string, relativePath: string) => {
      const result = await window.electronAPI.writingCheck.readFile({ projectId, relativePath });
      showFile(projectId, relativePath, result);
    },
    [showFile]
  );

  /** **Check a file…**: the picker opens in the project folder. */
  const pickFile = useCallback(
    async (projectId: string) => {
      const result = await window.electronAPI.writingCheck.pickFile({ projectId });
      showFile(projectId, '', result);
    },
    [showFile]
  );

  const showReply = useCallback((messageId: string) => {
    const row = document.querySelector<HTMLElement>(
      `.wb-msg[data-message-id="${CSS.escape(messageId)}"]`
    );
    if (!row) return;
    row.scrollIntoView?.({ block: 'center' });
    row.classList.add('is-focused');
    window.setTimeout(() => row.classList.remove('is-focused'), FOCUS_MS);
  }, []);

  return {
    check: state?.key === conversationKey ? state.check : null,
    request,
    close,
    showReply,
    checkFile,
    pickFile,
  };
}
