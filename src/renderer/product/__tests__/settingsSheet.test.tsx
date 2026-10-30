import React, { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '../../components/ui/sheet';
import { ProductReadyShell } from '../ProductReadyShell';
import { openSettings } from '../settingsNavigation';

const mounts = vi.hoisted(() => ({ chat: 0 }));

vi.mock('../chat/WorkbenchChatScreen', () => ({
  WorkbenchChatScreen: () => {
    useEffect(() => {
      mounts.chat += 1;
    }, []);
    return (
      <div>
        <textarea aria-label="Draft" defaultValue="" />
        <button type="button" onClick={() => openSettings({ tab: 'passwords', agentSlug: 'researcher' })}>
          view-login
        </button>
      </div>
    );
  },
}));
vi.mock('../ProductSettingsScreen', () => ({ ProductSettingsScreen: () => <div>settings-screen</div> }));
vi.mock('../AssistantServicesScreen', () => ({ AssistantServicesScreen: () => <div>services-screen</div> }));
vi.mock('../ResourcesScreen', () => ({ ResourcesScreen: () => <div>resources-screen</div> }));
vi.mock('../../onboarding/inferenceStatus', () => ({ useInferenceStatus: () => ({ status: null, error: null }) }));
vi.mock('../PasswordsLoginsPanel', () => ({
  PasswordsLoginsPanel: ({ initialAgentSlug }: { initialAgentSlug?: string }) => <p>{`logins:${initialAgentSlug}`}</p>,
}));
vi.mock('../CodingFoldersPanel', () => ({ CodingFoldersPanel: () => null }));
vi.mock('../AgentBrowserPanel', () => ({ AgentBrowserPanel: () => null }));
vi.mock('../ComputerAccessPanel', () => ({ ComputerAccessPanel: () => null }));
vi.mock('../UpdatesPanel', () => ({ UpdatesPanel: () => null }));
vi.mock('../CalendarsPanel', () => ({
  CalendarsPanel: ({ onConnectFromChatClosed }: { onConnectFromChatClosed?: () => void }) => {
    const [connecting, setConnecting] = useState(Boolean(onConnectFromChatClosed));
    const close = () => {
      setConnecting(false);
      onConnectFromChatClosed?.();
    };
    return (
      <>
        <p>calendars-panel</p>
        <button type="button" onClick={() => setConnecting(true)}>
          connect
        </button>
        <Sheet open={connecting} onClose={close} titleId="connect-title" title="Where is your calendar?" />
      </>
    );
  },
}));

function typeDraft(text: string) {
  const draft = screen.getByLabelText('Draft') as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: text } });
  return draft;
}

describe('Settings panels over the current screen', () => {
  beforeEach(() => {
    mounts.chat = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the chat, its draft and focus while a panel opens and closes', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    const draft = typeDraft('half a thought');
    const opener = screen.getByRole('button', { name: 'view-login' });
    opener.focus();

    fireEvent.click(opener);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Passwords & Logins' })).toBeTruthy();
    expect(screen.getByText('logins:researcher')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close Passwords & Logins' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mounts.chat).toBe(1);
    expect(screen.getByLabelText('Draft')).toBe(draft);
    expect(draft.value).toBe('half a thought');
    expect(document.activeElement).toBe(opener);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('makes the screen and rail inert only while a panel is open', () => {
    render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'App' });
    const content = screen.getByLabelText('Draft').closest('[inert]');
    expect(content).toBeNull();

    act(() => openSettings({ tab: 'access' }));
    expect(nav.hasAttribute('inert')).toBe(true);
    expect(screen.getByLabelText('Draft').closest('[inert]')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.hasAttribute('inert')).toBe(false);
    expect(screen.getByLabelText('Draft').closest('[inert]')).toBeNull();
  });

  it('closes when the backdrop is clicked, not when the panel is', () => {
    render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    act(() => openSettings({ tab: 'updates' }));
    const dialog = screen.getByRole('dialog', { name: 'Updates' });
    fireEvent.click(dialog);
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets a sheet inside the panel take Escape first', () => {
    render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    act(() => openSettings({ tab: 'calendars' }));
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    expect(screen.getByRole('dialog', { name: 'Where is your calendar?' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Where is your calendar?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Calendars' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns straight to the chat when the connect step it asked for is closed', () => {
    render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    act(() => openSettings({ tab: 'calendars', connectFromChat: true }));
    expect(screen.getByRole('dialog', { name: 'Where is your calendar?' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mounts.chat).toBe(1);
  });

  it('closes when the destination changes', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    act(() => openSettings({ tab: 'browser' }));
    rerender(<ProductReadyShell view="services" onNavigate={onNavigate} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('services-screen')).toBeTruthy();
  });

  it('opens over Services too', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="services" onNavigate={onNavigate} />);
    act(() => openSettings({ tab: 'calendars' }));
    expect(screen.getByRole('dialog', { name: 'Calendars' })).toBeTruthy();
    expect(screen.getByText('services-screen')).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
