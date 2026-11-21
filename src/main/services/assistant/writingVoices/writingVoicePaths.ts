import crypto from 'node:crypto';
import path from 'node:path';
import { getStackFiles } from '../../stackHost/activeStack';
import { localStackFiles } from '../../stackHost/localStackHost';
import type { StackFiles } from '../../stackHost/types';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';

/** The data folder of the stack this session talks to (a local checkout or the managed install). */
function activeContentRoot(): string {
  return resolveAssistantUserContentRoot(resolveActiveAssistantRoot());
}

/**
 * The files voices live in: the active stack's, or for tests a content folder on this machine.
 * Voices use the `userContent` location only.
 */
export function writingVoiceFiles(contentRoot?: string): StackFiles {
  if (!contentRoot) return getStackFiles();
  return localStackFiles({ stackRoot: contentRoot, userContentRoot: () => contentRoot });
}

/** `voice`, the stack's `/opt/voice`, under user content. */
export const WRITING_VOICE_ROOT = 'voice';

/** `voice/<id>` under user content, where the stack's write-in-voice skill looks. */
export function writingVoiceRel(id: string): string {
  return `${WRITING_VOICE_ROOT}/${id}`;
}

/** `<content root>/voice/<id>` on this machine, for Finder and the Trash. */
export function writingVoiceDir(id: string, contentRoot?: string): string {
  return path.join(contentRoot ?? activeContentRoot(), WRITING_VOICE_ROOT, id);
}

/**
 * Sample files under `dir` in user content, relative to it, skipping dotfiles as the skill does.
 * A link counts as what it points to.
 */
export async function listWritingVoiceFiles(
  files: StackFiles,
  dir: string,
  rel = ''
): Promise<Array<{ rel: string; size: number }>> {
  const out: Array<{ rel: string; size: number }> = [];
  const names = await files.list('userContent', path.posix.join(dir, rel));
  if (names === null) throw new Error(`No such folder: ${dir}`);
  for (const name of names) {
    // The skill skips dotfiles, and Finder adds .DS_Store; neither is a sample.
    if (name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const stat = await files.stat('userContent', path.posix.join(dir, childRel));
    if (stat?.kind === 'folder') out.push(...(await listWritingVoiceFiles(files, dir, childRel)));
    else if (stat?.kind === 'file') out.push({ rel: childRel, size: stat.size });
  }
  return out;
}

/** sha256 of the sorted "relative path\tsize" lines, to notice samples changing. */
export async function hashWritingVoiceSamples(files: StackFiles, samplesRel: string): Promise<string> {
  const lines = (await listWritingVoiceFiles(files, samplesRel)).map((f) => `${f.rel}\t${f.size}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}
