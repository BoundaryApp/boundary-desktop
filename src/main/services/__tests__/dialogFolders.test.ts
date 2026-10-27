import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing, dialogSavePath, dialogStartFolder, rememberDialogPick } from '../dialogFolders';

describe('dialogFolders', () => {
  let root: string;

  beforeEach(() => {
    __testing.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-folders-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts in the home directory before any pick', () => {
    expect(dialogStartFolder()).toBe(os.homedir());
    expect(dialogSavePath('notes.md')).toBe(path.join(os.homedir(), 'notes.md'));
  });

  it('starts in the folder that held the last picked folder', () => {
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    rememberDialogPick(project);
    expect(dialogStartFolder()).toBe(root);
  });

  it('starts in the folder of the last picked or saved file', () => {
    rememberDialogPick(path.join(root, 'report.pdf'));
    expect(dialogStartFolder()).toBe(root);
    expect(dialogSavePath('reply.md')).toBe(path.join(root, 'reply.md'));
  });

  it('keeps the latest pick', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    rememberDialogPick(path.join(root, 'a.txt'));
    rememberDialogPick(path.join(other, 'b.txt'));
    expect(dialogStartFolder()).toBe(other);
  });

  it('falls back to home when the remembered folder is gone', () => {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone);
    rememberDialogPick(path.join(gone, 'file.txt'));
    fs.rmSync(gone, { recursive: true });
    expect(dialogStartFolder()).toBe(os.homedir());
  });

  it('ignores canceled and relative picks', () => {
    rememberDialogPick(path.join(root, 'file.txt'));
    rememberDialogPick(undefined);
    rememberDialogPick('relative/file.txt');
    expect(dialogStartFolder()).toBe(root);
  });
});
