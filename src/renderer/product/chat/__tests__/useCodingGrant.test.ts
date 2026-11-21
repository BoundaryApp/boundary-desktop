import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { CodingAgentBusy } from '../../../../shared/types/codingFolders';

const codingAgentBusy = vi.fn();

stubElectronAPI({
  codingFolders: {
    busy: (...args: unknown[]) => codingAgentBusy(...args),
  },
});

import { useCodingGrant } from '../useCodingGrant';

const running: CodingAgentBusy = { busy: true, sessions: ['Fix the tests'] };

/** A busy answer the test settles by hand. */
function pendingBusy() {
  let answer: (value: CodingAgentBusy) => void = () => undefined;
  codingAgentBusy.mockReturnValueOnce(
    new Promise<CodingAgentBusy>((resolve) => {
      answer = resolve;
    })
  );
  return (value: CodingAgentBusy) => answer(value);
}

beforeEach(() => {
  codingAgentBusy.mockReset();
});

describe('useCodingGrant', () => {
  it('keeps the answer to a check', async () => {
    codingAgentBusy.mockResolvedValue(running);
    const { result } = renderHook(() => useCodingGrant());

    await act(async () => {
      await result.current.check();
    });

    expect(result.current.agent).toEqual(running);
  });

  it('ignores a check that finishes after reset', async () => {
    const answer = pendingBusy();
    const { result } = renderHook(() => useCodingGrant());
    let checked: Promise<CodingAgentBusy> = Promise.resolve(running);
    act(() => {
      checked = result.current.check();
    });

    act(() => result.current.reset());
    await act(async () => {
      answer(running);
      await checked;
    });

    expect(result.current.agent).toBeNull();
  });

  it('keeps only the latest of two checks', async () => {
    const first = pendingBusy();
    const second = pendingBusy();
    const { result } = renderHook(() => useCodingGrant());
    let firstCheck: Promise<CodingAgentBusy> = Promise.resolve(running);
    let secondCheck: Promise<CodingAgentBusy> = Promise.resolve(running);
    act(() => {
      firstCheck = result.current.check();
      secondCheck = result.current.check();
    });

    await act(async () => {
      second({ busy: false, sessions: [] });
      await secondCheck;
      first(running);
      await firstCheck;
    });

    expect(result.current.agent).toEqual({ busy: false, sessions: [] });
  });
});
