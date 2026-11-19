import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OfferedService, SharedServicesView, SharingCircle } from '../../../../shared/types/sharedServices';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { AddonDetail } from '../AddonDetail';
import { FromYourCircles, SharedLine, ShareSheet } from '../SharedTwenty';
import { listing, localWorkspace, stubAddons } from './addonFixtures';

const ok = async () => ({ success: true as const });

function stubCircles(view: SharedServicesView = { sharing: [], offered: [] }) {
  const circles = {
    services: vi.fn(async () => ({ success: true, view })),
    serviceShare: vi.fn(ok),
    serviceStopSharing: vi.fn(ok),
    serviceUse: vi.fn(async () => ({ success: true, slug: 'ada-family' })),
    serviceStopUsing: vi.fn(ok),
  };
  stubElectronAPI({ circles });
  return circles;
}

const family: SharingCircle = {
  circle: 'c1',
  circleName: 'Family',
  offer: null,
  members: [
    { identity: 'bo', name: 'Bo', level: null, callsToday: 0 },
    { identity: 'cy', name: 'Cy', level: null, callsToday: 0 },
  ],
};

const offer: OfferedService = {
  circle: 'c1',
  circleName: 'Family',
  provider: 'ada',
  providerName: 'Ada',
  online: true,
  service: 'twenty.main',
  name: 'Twenty',
  levels: ['read', 'write'],
  available: true,
  slug: null,
};

describe('ShareSheet', () => {
  it('shares with every member able to look things up by default', async () => {
    const circles = stubCircles();
    const onClose = vi.fn();
    render(<ShareSheet circles={[family]} initial={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(circles.serviceShare).toHaveBeenCalledWith({ circle: 'c1', write: false, away: false, members: { bo: 'read', cy: 'read' } });
  });

  it('allows changes, gives one member them, takes another’s access away and keeps the Mac awake', async () => {
    const circles = stubCircles();
    render(<ShareSheet circles={[family]} initial={null} onClose={() => undefined} />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Members may' })).getByRole('radio', { name: 'Make changes' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'What Bo may do' })).getByRole('radio', { name: 'Make changes' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'What Cy may do' })).getByRole('radio', { name: 'No access' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep this Mac awake while Boundary is open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(circles.serviceShare).toHaveBeenCalled());
    expect(circles.serviceShare).toHaveBeenCalledWith({ circle: 'c1', write: true, away: true, members: { bo: 'write', cy: null } });
  });

  it('lowers a member’s changes to looking things up when the Circle no longer allows changes', async () => {
    const circles = stubCircles();
    const shared: SharingCircle = {
      ...family,
      offer: { levels: ['read', 'write'], away: false, available: true },
      members: [{ identity: 'bo', name: 'Bo', level: 'write', callsToday: 3 }],
    };
    render(<ShareSheet circles={[shared]} initial="c1" onClose={() => undefined} />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Members may' })).getByRole('radio', { name: 'Look things up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(circles.serviceShare).toHaveBeenCalled());
    expect(circles.serviceShare).toHaveBeenCalledWith({ circle: 'c1', write: false, away: false, members: { bo: 'read' } });
  });

  it('shows the error and stays open when sharing fails', async () => {
    const circles = stubCircles();
    circles.serviceShare.mockResolvedValueOnce({ success: false, error: 'Twenty isn’t running.' } as never);
    const onClose = vi.fn();
    render(<ShareSheet circles={[family]} initial={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Twenty isn’t running.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('SharedLine', () => {
  const shared: SharingCircle = {
    ...family,
    offer: { levels: ['read'], away: true, available: true },
    members: [
      { identity: 'bo', name: 'Bo', level: 'read', callsToday: 14 },
      { identity: 'cy', name: 'Cy', level: null, callsToday: 0 },
    ],
  };

  it('says who has access, today’s calls and how many have none', () => {
    stubCircles();
    render(<SharedLine circle={shared} onChange={() => undefined} />);
    expect(screen.getByText('Bo · Look things up · 14 calls today')).toBeTruthy();
    expect(screen.getByText('1 member has no access')).toBeTruthy();
    expect(screen.getByText('Keeps this Mac awake while Boundary is open')).toBeTruthy();
  });

  it('stops sharing in that Circle', async () => {
    const circles = stubCircles();
    render(<SharedLine circle={shared} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(circles.serviceStopSharing).toHaveBeenCalledWith({ circle: 'c1' }));
  });
});

describe('FromYourCircles', () => {
  const props = { accessOf: () => 'read' as const, accessSwitch: () => <span>access switch</span> };

  it('turns Use in my agent on with read access, and off again', async () => {
    const circles = stubCircles();
    const { rerender } = render(<FromYourCircles offered={[offer]} {...props} />);
    expect(screen.getByText('Adds its tools to every chat after a restart.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use in my agent' }));
    await waitFor(() =>
      expect(circles.serviceUse).toHaveBeenCalledWith({ circle: 'c1', provider: 'ada', service: 'twenty.main', access: 'read' })
    );
    rerender(<FromYourCircles offered={[{ ...offer, slug: 'ada-family' }]} {...props} />);
    expect(screen.getByText('crm-ada-family')).toBeTruthy();
    expect(screen.getByText('access switch')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use in my agent' }));
    await waitFor(() => expect(circles.serviceStopUsing).toHaveBeenCalledWith({ circle: 'c1', provider: 'ada', service: 'twenty.main' }));
  });

  it('says the provider is offline', () => {
    stubCircles();
    render(<FromYourCircles offered={[{ ...offer, online: false }]} {...props} />);
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText('Calls say Ada’s Mac is offline until it’s back.')).toBeTruthy();
  });

  it('renders nothing with no offers', () => {
    stubCircles();
    const { container } = render(<FromYourCircles offered={[]} {...props} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('Twenty page with Circles', () => {
  it('lists a used Circle workspace under From your Circles, not as hosted', async () => {
    stubAddons([listing({}, true)], {
      workspaces: [localWorkspace(), localWorkspace({ slug: 'ada-family', local: false, url: 'http://host.docker.internal:41000' })],
    });
    stubCircles({ sharing: [family], offered: [{ ...offer, slug: 'ada-family' }] });
    render(<AddonDetail id="twenty" onBack={() => undefined} onInstallStarted={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'From your Circles' })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: /^Hosted crm-ada-family/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Share with a Circle…' })).toBeTruthy();
  });
});

describe('sharedToolSource', () => {
  it('finds the shared workspace from Hermes’s tool name', async () => {
    const { sharedToolSource } = await import('../SharedTwenty');
    const used = { ...offer, slug: 'ada-family' };
    expect(sharedToolSource('mcp__crm_ada_family__execute_tool', [used])).toBe(used);
    expect(sharedToolSource('mcp__crm_main__execute_tool', [used])).toBeNull();
    expect(sharedToolSource('mcp__crm_ada_family__execute_tool', [offer])).toBeNull();
  });
});
