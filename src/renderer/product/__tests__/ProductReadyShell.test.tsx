import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductReadyShell } from '../ProductReadyShell';
import { openSettings } from '../settingsNavigation';

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

vi.mock('../ResourcesScreen', () => ({
  ResourcesScreen: () => <div>resources-screen</div>,
}));

describe('ProductReadyShell navigation', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens Settings on the tab and agent another screen asked for', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
    act(() => openSettings({ tab: 'passwords', agentSlug: 'researcher' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    rerender(<ProductReadyShell view="settings" onNavigate={onNavigate} />);
    expect(screen.getByText('tab:passwords agent:researcher')).toBeTruthy();
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
    expect(document.querySelector('.wb-mark')).toBeTruthy();

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
    expect(onNavigate).toHaveBeenLastCalledWith('services');
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('settings');
  });

  it('opens Chat first when a chat command arrives on another destination', () => {
    const onNavigate = vi.fn();
    render(<ProductReadyShell view="resources" onNavigate={onNavigate} />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith('chat');
  });
});
