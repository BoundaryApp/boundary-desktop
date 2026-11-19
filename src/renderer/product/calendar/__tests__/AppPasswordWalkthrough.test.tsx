import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { AppPasswordWalkthrough } from '../AppPasswordWalkthrough';

const openUrl = vi.fn();

function setup(props: Partial<React.ComponentProps<typeof AppPasswordWalkthrough>> = {}) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<AppPasswordWalkthrough onDone={onDone} onClose={onClose} {...props} />);
  return { onDone, onClose };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const heading = () => screen.getByRole('heading', { level: 3 });

describe('AppPasswordWalkthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openUrl.mockResolvedValue({ success: true });
    stubElectronAPI({ urls: { openUrl: (url: string) => openUrl(url) } });
  });

  it('steps through five slides with Next, Back and the arrow keys', () => {
    setup();
    expect(heading().textContent).toBe('Open account.apple.com');
    expect(document.activeElement).toBe(heading());
    for (let i = 0; i < 4; i++) next();
    expect(heading().textContent).toBe('Paste the password');
    expect(document.activeElement).toBe(heading());
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(heading().textContent).toBe('Apple may ask for your Apple Account password');
    expect(document.activeElement).toBe(heading());
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(heading().textContent).toBe('Apple may ask for your Apple Account password');
  });

  it('opens account.apple.com in the browser from slide 1', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Open account.apple.com' }));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://account.apple.com/');
  });

  it('returns the pasted password on Done', () => {
    const { onDone } = setup();
    for (let i = 0; i < 4; i++) next();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith('abcd-efgh-ijkl-mnop');
  });

  it('warns about a password that is not four groups of four letters, and still allows Done', () => {
    const { onDone } = setup();
    for (let i = 0; i < 4; i++) next();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'hunter2' } });
    expect(screen.getByRole('alert').textContent).toContain('That doesn’t look like an app-specific password.');
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledWith('hunter2');
  });

  it('starts from the password already typed in the sheet', () => {
    setup({ initialPassword: 'abcd-efgh-ijkl-mnop' });
    for (let i = 0; i < 4; i++) next();
    expect((screen.getByLabelText('App-specific password') as HTMLInputElement).value).toBe('abcd-efgh-ijkl-mnop');
  });

  it('closes on Escape', () => {
    const { onClose } = setup();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the Calendars on this Mac line when onUseMac is unset', () => {
    setup();
    expect(screen.queryByText(/Calendars on this Mac/)).toBeNull();
    cleanup();
    const onUseMac = vi.fn();
    setup({ onUseMac });
    fireEvent.click(screen.getByRole('button', { name: /Calendars on this Mac/ }));
    expect(onUseMac).toHaveBeenCalledTimes(1);
  });
});
