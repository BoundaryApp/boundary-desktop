import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// A build with no experiments: the marks fall back to the app's own face. Builds with an
// experiment can draw their own built-in mark; this file checks the app's own.
vi.mock('../../../experiments', () => ({ rendererExperiments: [] }));

import { AgentMark, BuiltinAgentSectionMark, ConversationMark } from '../ConversationMark';

const mark = (container: HTMLElement) => container.querySelector('.wb-kind-mark') as HTMLElement;

describe("the built-in agent's section head", () => {
  it('shows the start-up face at 14px', () => {
    const { container } = render(<BuiltinAgentSectionMark />);
    const face = container.querySelector('.wb-kind-mark.is-hermes.is-14.is-face');
    expect(face?.querySelector('svg')?.getAttribute('viewBox')).toBe('0.5 0.3 13 13');
    // The antenna's ball, and the head with its eyes cut out of it.
    expect(face?.querySelector('circle')).not.toBeNull();
    expect(face?.querySelector('path[fill-rule="evenodd"]')).not.toBeNull();
  });

  it("differs from the speech bubble that marks the agent's chats", () => {
    const head = render(<BuiltinAgentSectionMark />).container.querySelector('svg');
    const row = render(<ConversationMark kind="hermes" />).container.querySelector('svg');
    expect(row?.getAttribute('viewBox')).toBe('-2 -1.6 20 20');
    expect(head?.innerHTML).not.toBe(row?.innerHTML);
  });
});

describe('AgentMark', () => {
  it('gives the built-in agent its face, not the mark its chats use', () => {
    for (const size of [14, 18, 24] as const) {
      const { container } = render(
        <AgentMark agent={{ slug: 'hermes', displayName: 'Hermes', builtIn: true }} size={size} />
      );
      expect(mark(container).className).toBe(`wb-kind-mark is-hermes is-${size} is-face`);
      expect(mark(container).querySelector('circle')).not.toBeNull();
    }
  });

  it('gives a personality its DM mark with its initial', () => {
    const { container } = render(
      <AgentMark agent={{ slug: 'ada', displayName: 'ada', builtIn: false }} />
    );
    expect(mark(container).className).toBe('wb-kind-mark is-dm is-18');
    expect(mark(container).textContent).toBe('A');
  });

  it('draws a DM mark for an agent that is not loaded yet', () => {
    const { container } = render(<AgentMark agent={undefined} size={24} />);
    expect(mark(container).className).toBe('wb-kind-mark is-dm is-24');
  });
});
