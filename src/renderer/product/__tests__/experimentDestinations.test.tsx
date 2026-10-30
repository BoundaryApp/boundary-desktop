import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductIconRail } from '../ProductIconRail';
import { ProductReadyShell } from '../ProductReadyShell';

vi.mock('../../experiments', () => ({
  rendererExperiments: [],
  experimentDestinations: () => [
    {
      id: 'demo',
      label: 'Demo',
      Icon: () => <svg data-testid="demo-icon" />,
      Screen: () => <div>demo-screen</div>,
    },
  ],
}));

vi.mock('../assistantStack', () => ({ useAssistantStackStatus: () => null }));
vi.mock('../chat/WorkbenchChatScreen', () => ({ WorkbenchChatScreen: () => <div>chat-screen</div> }));
vi.mock('../AssistantServicesScreen', () => ({ AssistantServicesScreen: () => <div>services-screen</div> }));
vi.mock('../ProductSettingsScreen', () => ({ ProductSettingsScreen: () => <div>settings-screen</div> }));
vi.mock('../ResourcesScreen', () => ({ ResourcesScreen: () => <div>resources-screen</div> }));

describe('experiment destinations', () => {
  afterEach(cleanup);

  it('get a rail button with no shortcut that navigates to experiment:<id>', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ProductIconRail active="chat" onNavigate={onNavigate} />);
    const button = screen.getByRole('button', { name: 'Demo' });
    expect(button.getAttribute('title')).toBe('Demo');
    expect(button.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(button.getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('demo-icon')).toBeTruthy();

    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith('experiment:demo');

    rerender(<ProductIconRail active="experiment:demo" onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Demo' }).getAttribute('aria-current')).toBe('page');
  });

  it('sit above Settings in the rail', () => {
    render(<ProductIconRail active="chat" />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.slice(-2)).toEqual(['Demo', 'Settings']);
  });

  it('render their screen in the shell, and an unknown one falls back to chat', () => {
    const { rerender } = render(<ProductReadyShell view="experiment:demo" onNavigate={vi.fn()} />);
    expect(screen.getByText('demo-screen')).toBeTruthy();

    rerender(<ProductReadyShell view="experiment:gone" onNavigate={vi.fn()} />);
    expect(screen.queryByText('demo-screen')).toBeNull();
    expect(screen.getByText('chat-screen')).toBeTruthy();
  });
});
