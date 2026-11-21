import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProductReadyShell } from '../ProductReadyShell';
import { openSettings } from '../settingsNavigation';
import { openInference } from '../inference/inferenceNavigation';

vi.mock('../desktopAgent/DesktopAgentHost', () => ({
  DesktopAgentHost: () => <div>desktop-agent-host</div>,
}));

vi.mock('../chat/WorkbenchChatScreen', () => ({
  WorkbenchChatScreen: () => <div>chat-screen</div>,
}));

vi.mock('../AssistantServicesScreen', () => ({
  AssistantServicesScreen: () => <div>services-screen</div>,
}));

vi.mock('../ProductSettingsScreen', () => ({
  ProductSettingsScreen: ({
    onBack,
    initialTab,
    initialAgentSlug,
  }: {
    onBack: () => void;
    initialTab?: string;
    initialAgentSlug?: string;
  }) => (
    <div>
      <span>settings-screen</span>
      <span>{`tab:${initialTab ?? 'none'} agent:${initialAgentSlug ?? 'none'}`}</span>
      <button type="button" onClick={onBack}>
        back-to-chat
      </button>
    </div>
  ),
}));

vi.mock('../inference/InferenceScreen', () => ({
  InferenceScreen: ({ focusPerson }: { focusPerson?: { person?: string } }) => (
    <div>inference-screen:{focusPerson?.person ?? 'none'}</div>
  ),
}));

vi.mock('../ResourcesScreen', () => ({
  ResourcesScreen: () => <div>resources-screen</div>,
}));

vi.mock('../circles/CirclesScreen', () => ({
  CirclesScreen: () => <div>circles-screen</div>,
}));

vi.mock('../whatsNew/WhatsNewScreen', () => ({
  WhatsNewScreen: ({ scrollTo }: { scrollTo?: string }) => <div>whats-new-screen:{scrollTo ?? 'top'}</div>,
}));

vi.mock('../whatsNew/GuideScreen', () => ({
  GuideScreen: ({ guideId }: { guideId: string }) => <div>guide-screen:{guideId}</div>,
}));

vi.mock('../../experiments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../experiments')>()),
  rendererExperiments: [{ Overlay: () => <div>experiment-overlay</div> }],
}));

describe('ProductReadyShell navigation', () => {
  it('reports the open screen and sheet to main', () => {
    const api = window.electronAPI as unknown as { hostBridge?: object };
    const hostBridge = api.hostBridge;
    const reportScreen = vi.fn(async () => undefined);
    api.hostBridge = { ...hostBridge, reportScreen };
    const onNavigate = vi.fn();
    const { rerender } = render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    expect(reportScreen).toHaveBeenLastCalledWith({ view: 'chat', sheet: null });
    act(() => openSettings({ tab: 'passwords' }));
    expect(reportScreen).toHaveBeenLastCalledWith({ view: 'chat', sheet: 'passwords' });
    rerender(<ProductReadyShell view="services" onNavigate={onNavigate} />);
    expect(reportScreen).toHaveBeenLastCalledWith({ view: 'services', sheet: null });
    api.hostBridge = hostBridge;
  });

  it('moves to the asked-for tab when Settings is already open', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="settings" onNavigate={onNavigate} />);
    act(() => openSettings({ tab: 'passwords', agentSlug: 'researcher' }));
    expect(screen.getByText('tab:passwords agent:researcher')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the Settings screen for General, which is more than one panel', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    act(() => openSettings({ tab: 'general' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('defaults to chat and switches Services / Settings via the rail', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <ProductReadyShell view="chat" onNavigate={onNavigate} />
    );
    expect(screen.getByText('chat-screen')).toBeTruthy();
    const chat = screen.getByLabelText('Chat');
    expect(chat.getAttribute('aria-current')).toBe('page');
    expect(chat.className).toContain('is-on');
    expect(chat.className).toContain('wb-icon-btn');
    expect(document.querySelector('.workbench')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Services'));
    expect(onNavigate).toHaveBeenCalledWith('services');

    rerender(<ProductReadyShell view="services" onNavigate={onNavigate} />);
    expect(screen.getByText('services-screen')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Resources'));
    expect(onNavigate).toHaveBeenCalledWith('resources');

    rerender(<ProductReadyShell view="resources" onNavigate={onNavigate} />);
    expect(screen.getByText('resources-screen')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Settings'));
    expect(onNavigate).toHaveBeenCalledWith('settings');

    rerender(<ProductReadyShell view="settings" onNavigate={onNavigate} />);
    expect(screen.getByText('settings-screen')).toBeTruthy();

    fireEvent.click(screen.getByText('back-to-chat'));
    expect(onNavigate).toHaveBeenCalledWith('chat');
  });

  it('switches destinations from keyboard shortcuts', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('circles');
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('inference');
    fireEvent.keyDown(window, { key: '4', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('services');
    fireEvent.keyDown(window, { key: '5', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('resources');
    // Nothing is on ⌘6.
    onNavigate.mockClear();
    fireEvent.keyDown(window, { key: '6', ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('settings');
  });

  it('renders each destination’s screen', () => {
    const { rerender } = render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    const screens: [Parameters<typeof ProductReadyShell>[0]['view'], string][] = [
      ['chat', 'chat-screen'],
      ['circles', 'circles-screen'],
      ['inference', 'inference-screen:none'],
      ['services', 'services-screen'],
      ['resources', 'resources-screen'],
      ['settings', 'settings-screen'],
      ['whats-new', 'whats-new-screen:top'],
    ];
    for (const [view, text] of screens) {
      rerender(<ProductReadyShell view={view} onNavigate={vi.fn()} />);
      expect(screen.getByText(text), view).toBeTruthy();
    }
    rerender(
      <ProductReadyShell view="whats-new" onNavigate={vi.fn()} whatsNewRequest={{ seq: 1, guide: 'g1' }} />
    );
    expect(screen.getByText('guide-screen:g1')).toBeTruthy();
    rerender(
      <ProductReadyShell view="whats-new" onNavigate={vi.fn()} whatsNewRequest={{ seq: 2, version: 'v2' }} />
    );
    expect(screen.getByText('whats-new-screen:v2')).toBeTruthy();
  });

  it('switches to Chat from ⌘1 on another destination', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="resources" onNavigate={onNavigate} />);
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('chat');
  });

  it('opens Inference at a person from a link about their model', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    act(() => openInference({ person: 'b'.repeat(64) }));
    expect(onNavigate).toHaveBeenLastCalledWith('inference');
    rerender(<ProductReadyShell view="inference" onNavigate={onNavigate} />);
    expect(screen.getByText(`inference-screen:${'b'.repeat(64)}`)).toBeTruthy();
  });

  it('opens Chat first when a chat command arrives on another destination', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="resources" onNavigate={onNavigate} />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('chat');
  });

  it('shows the agent button everywhere but Chat, and ⌘J opens Chat from it until the window lands', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
    // ⌘J on Chat does nothing, and isn't sent on to Chat as a chat command.
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();

    rerender(<ProductReadyShell view="resources" onNavigate={onNavigate} />);
    const button = screen.getByRole('button', { name: /^Ask / });
    // At its default spot the content area keeps room for it.
    expect(button.parentElement?.className).toContain('wb-agent-room');
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('chat');
  });

  it('with the desktop button on, mounts it and shows no in-window button on any screen (ADR 0058 §2)', async () => {
    const api = window.electronAPI as unknown as { desktopAgent?: object };
    const was = api.desktopAgent;
    api.desktopAgent = {
      get: vi.fn().mockResolvedValue({ available: true, on: true, hidden: false }),
      onChanged: vi.fn((): (() => void) => () => undefined),
      onHiddenChanged: vi.fn((): (() => void) => () => undefined),
    };
    const { rerender } = render(<ProductReadyShell view="resources" onNavigate={vi.fn()} />);
    expect(await screen.findByText('desktop-agent-host')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
    expect(document.querySelector('.wb-agent-room')).toBeNull();
    rerender(<ProductReadyShell view="circles" onNavigate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
    api.desktopAgent = was;
  });

  it('with the desktop button off, keeps the in-window button and mounts no desktop one', async () => {
    render(<ProductReadyShell view="resources" onNavigate={vi.fn()} />);
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: /^Ask / })).toBeTruthy();
    expect(screen.queryByText('desktop-agent-host')).toBeNull();
  });
});

describe('experiment overlays', () => {
  it('draws an experiment overlay and makes it inert while a settings sheet is open', () => {
    render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    const overlay = screen.getByText('experiment-overlay');
    expect(overlay.closest('[inert]')).toBeNull();
    act(() => openSettings({ tab: 'passwords' }));
    expect(screen.getByText('experiment-overlay').closest('[inert]')).not.toBeNull();
  });
});
