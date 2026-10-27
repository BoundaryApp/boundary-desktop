import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentMark } from '../ConversationMark';

const mark = (container: HTMLElement) => container.querySelector('.wb-kind-mark') as HTMLElement;

describe('AgentMark', () => {
  it('gives the built-in agent the Hermes mark', () => {
    const { container } = render(
      <AgentMark agent={{ slug: 'hermes', displayName: 'Hermes', builtIn: true }} size={14} />
    );
    expect(mark(container).className).toBe('wb-kind-mark is-hermes is-14');
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
