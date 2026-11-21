import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { DEFAULT_REPLY_TEXT, REPLY_TEXT_STORAGE_KEY } from '../../../shared/replyText';
import { initReplyText } from '../../replyText';
import { ProductSettingsScreen } from '../ProductSettingsScreen';
import { ReplyTextPanel } from '../ReplyTextPanel';

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

function useMemoryStorage(): Map<string, string> {
  const memory = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string): void => void memory.set(key, value),
      removeItem: (key: string): void => void memory.delete(key),
      clear: () => memory.clear(),
    },
  });
  return memory;
}

describe('reply text', () => {
  let memory: Map<string, string>;

  beforeEach(() => {
    memory = useMemoryStorage();
    document.documentElement.removeAttribute('style');
    initReplyText();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies the default before anything is stored', () => {
    initReplyText();
    expect(rootVar('--font-reply')).toBe('var(--font-prose)');
    expect(rootVar('--size-prose')).toBe('15.5px');
    expect(rootVar('--leading-prose')).toBe('1.7');
    expect(rootVar('--prose-paragraph-gap')).toBe('1.1em');
    expect(rootVar('--prose-list-gap')).toBe('0.5em');
    expect(rootVar('--weight-prose')).toBe('400');
  });

  it('applies a stored choice at startup and ignores a corrupt one', () => {
    memory.set(REPLY_TEXT_STORAGE_KEY, JSON.stringify({ ...DEFAULT_REPLY_TEXT, face: 'sans', size: 15, weight: 430 }));
    initReplyText();
    expect(rootVar('--font-reply')).toBe('var(--font-ui)');
    expect(rootVar('--size-prose')).toBe('15px');
    expect(rootVar('--weight-prose')).toBe('430');

    memory.set(REPLY_TEXT_STORAGE_KEY, '{not json');
    initReplyText();
    expect(rootVar('--size-prose')).toBe('15.5px');
  });

  it('loads a choice saved as JSON by earlier builds, clamping values out of range', () => {
    memory.set(REPLY_TEXT_STORAGE_KEY, '{"face":"sans","size":30,"lineHeight":1.5,"paragraphGap":1,"listGap":0.3,"weight":450}');
    initReplyText();
    expect(rootVar('--font-reply')).toBe('var(--font-ui)');
    expect(rootVar('--size-prose')).toBe('18px');
    expect(rootVar('--leading-prose')).toBe('1.5');
    expect(rootVar('--weight-prose')).toBe('450');
  });

  it('stores and applies each change, and resets to the default', () => {
    render(<ReplyTextPanel />);
    const reset = screen.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Sans' }));
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('List item spacing'), { target: { value: '0.4' } });

    expect(rootVar('--font-reply')).toBe('var(--font-ui)');
    expect(rootVar('--size-prose')).toBe('15px');
    expect(rootVar('--prose-list-gap')).toBe('0.4em');
    expect(JSON.parse(memory.get(REPLY_TEXT_STORAGE_KEY) ?? '{}')).toMatchObject({ face: 'sans', size: 15, listGap: 0.4 });
    expect(reset.disabled).toBe(false);

    fireEvent.click(reset);
    expect(rootVar('--font-reply')).toBe('var(--font-prose)');
    expect(rootVar('--size-prose')).toBe('15.5px');
    expect(reset.disabled).toBe(true);
  });

  it('holds the serif at 400 and lets the sans weight change', () => {
    render(<ReplyTextPanel />);
    const weight = screen.getByLabelText('Weight') as HTMLInputElement;
    expect(weight.disabled).toBe(true);
    expect(screen.getByText('The serif face comes in fixed weights. Switch to Sans to change it.')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Sans' }));
    expect(weight.disabled).toBe(false);
    fireEvent.change(weight, { target: { value: '440' } });
    expect(rootVar('--weight-prose')).toBe('440');

    fireEvent.click(screen.getByRole('radio', { name: 'Serif' }));
    expect(rootVar('--weight-prose')).toBe('400');
  });

  it('previews a prompt and a rendered reply with the transcript classes', () => {
    render(<ReplyTextPanel />);
    const preview = screen.getByRole('group', { name: 'Reply preview' });
    expect(preview.querySelector('.wb-msg.is-user .wb-bubble')).toBeTruthy();
    expect(preview.querySelector('.wb-prose .wb-streamdown ul li')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Paragraphs' }));
    expect(preview.querySelector('.wb-prose ul')).toBeNull();
  });

  it('is reached from Appearance, whose row summarises the current choice', () => {
    stubElectronAPI({
      onboarding: {
        getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }),
      },
    });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    const appearance = screen.getByRole('region', { name: 'Appearance' });
    expect(within(appearance).getByText('Serif · 15.5px · line height 1.7')).toBeTruthy();

    fireEvent.click(within(appearance).getByRole('button', { name: 'Adjust' }));
    expect(screen.getByRole('tab', { name: 'Reply text' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('region', { name: 'Reply text' })).toBeTruthy();
  });
});
