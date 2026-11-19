import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';

/** The data folder of the stack this session talks to (a local checkout or the managed install). */
function activeContentRoot(): string {
  return resolveAssistantUserContentRoot(resolveActiveAssistantRoot());
}

/** `<content root>/voice`, the stack's `/opt/voice`. */
export function writingVoiceRoot(contentRoot?: string): string {
  return path.join(contentRoot ?? activeContentRoot(), 'voice');
}

/** `<content root>/voice/<id>`, where the stack's write-in-voice skill looks. */
export function writingVoiceDir(id: string, contentRoot?: string): string {
  return path.join(writingVoiceRoot(contentRoot), id);
}

/** Sample files under `dir`, relative, skipping dotfiles as the skill does. */
export async function listWritingVoiceFiles(
  dir: string,
  rel = ''
): Promise<Array<{ rel: string; size: number }>> {
  const out: Array<{ rel: string; size: number }> = [];
  for (const entry of await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })) {
    // The skill skips dotfiles, and Finder adds .DS_Store; neither is a sample.
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listWritingVoiceFiles(dir, childRel)));
    else if (entry.isFile()) {
      out.push({ rel: childRel, size: (await fs.promises.stat(path.join(dir, childRel))).size });
    }
  }
  return out;
}

/** sha256 of the sorted "relative path\tsize" lines, to notice samples changing. */
export async function hashWritingVoiceSamples(samplesDir: string): Promise<string> {
  const lines = (await listWritingVoiceFiles(samplesDir)).map((f) => `${f.rel}\t${f.size}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}
