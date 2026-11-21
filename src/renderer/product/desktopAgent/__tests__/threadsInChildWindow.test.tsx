import React from 'react';
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleMessage, CircleSnapshot } from '../../../../shared/types/circles';
import { ME, circleMember, circleSnapshot } from '../../../__tests__/circleFixtures';
import { installElectronAPI } from '../../../__tests__/electronApiFake';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import { OwnerDocumentProvider } from '../../../components/ui/ownerDocument';
import { CircleThread } from '../../chat/circle/CircleThread';
import type { CircleChatView } from '../../circles/useCircleChat';

// The real picker needs layout the test DOM lacks; only the thread's own handling matters here.
vi.mock('../../chat/circle/EmojiPickerSheet', () => ({ default: (): null => null }));

/**
 * The real Circle thread drawn in a second window, as the desktop panel draws it (ADR 0058). Its
 * keys, outside clicks and sheets must work in that window's document, not the hidden app window's.
 */
const MAYA = 'bb'.repeat(32);
const AT = Date.UTC(2026, 10, 3, 9, 12);
const ada = circleMember({ identity: ME, name: 'Ada', isMe: true });
const maya = circleMember({ identity: MAYA, name: 'Maya', role: 'admin' });
const circle = (extra: Partial<CircleSnapshot> = {}): CircleSnapshot =>
  circleSnapshot({ name: 'Book club', members: [ada, maya], ...extra });

const message = (text: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
  circleKey: 'cc'.repeat(32),
  channel: 'general',
  author: MAYA,
  id: '0000000000000001',
  name: 'Maya',
  agent: null,
  text,
  at: AT,
  confirmed: true,
  edited: false,
  deleted: null,
  shared: null,
  call: null,
  mentions: null,
  reply: null,
  reactions: [],
  mine: false,
  ...extra,
});

const chatOf = (messages: CircleMessage[]): CircleChatView => ({
  messages,
  loading: false,
  more: false,
  error: null,
  goneCount: 0,
  loadOlder: vi.fn(async () => undefined),
  send: vi.fn(async () => null),
  edit: vi.fn(async () => null),
  remove: vi.fn(async () => null),
  react: vi.fn(async () => null),
  seen: 0,
  markRead: vi.fn(),
  typing: [],
  seenBy: {},
  notifyTyping: vi.fn(),
});

const childWindows: HappyWindow[] = [];
function childDocument(): Document {
  const child = new HappyWindow();
  childWindows.push(child);
  return child.document as unknown as Document;
}

function showInChild(doc: Document, node: React.ReactNode) {
  return render(createPortal(<OwnerDocumentProvider doc={doc}>{node}</OwnerDocumentProvider>, doc.body));
}

beforeEach(() => {
  installElectronAPI();
});

afterEach(async () => {
  cleanup();
  for (const child of childWindows.splice(0)) await child.happyDOM.close();
});

describe('CircleThread in a child window', () => {
  it('leaves select mode on Escape pressed in its own window, not the app window', () => {
    const doc = childDocument();
    const stop = vi.fn();
    showInChild(
      doc,
      <CircleThread
        circle={circle({ myRole: 'admin' })}
        channel={{ id: 'general', name: 'General' }}
        chat={chatOf([message('Hers')])}
        selecting
        onStopSelecting={stop}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(stop).not.toHaveBeenCalled();
    fireEvent.keyDown(doc, { key: 'Escape' });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('closes the React popover on a click elsewhere in its own window', async () => {
    const doc = childDocument();
    showInChild(
      doc,
      <CircleThread circle={circle()} channel={{ id: 'general', name: 'General' }} chat={chatOf([message('Hers')])} />
    );
    const body = within(doc.body as HTMLElement);
    openMenu(body.getByRole('button', { name: 'React' }));
    await flushMenu();
    expect(body.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await flushMenu();
    expect(body.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerDown(doc.body);
    await flushMenu();
    expect(body.queryByRole('menu')).toBeNull();
  });

  it('opens the link sheet in its own window', () => {
    const doc = childDocument();
    showInChild(
      doc,
      <CircleThread
        circle={circle()}
        channel={{ id: 'general', name: 'General' }}
        chat={chatOf([message('See https://example.com/a', { author: ME, name: 'Ada', mine: true })])}
      />
    );
    const body = within(doc.body as HTMLElement);
    fireEvent.click(body.getByRole('button', { name: 'https://example.com/a' }));
    expect(body.getByRole('dialog', { name: 'Open this link in your browser?' })).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
