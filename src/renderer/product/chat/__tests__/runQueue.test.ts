import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRunQueuesForTests,
  enqueuePrompt,
  getRunQueue,
  pauseRunQueue,
  queueChipLabel,
  removeQueuedPrompt,
  rekeyRunQueue,
  resumeRunQueue,
  shiftQueuedPrompt,
  takeQueuedPrompt,
} from '../runQueue';

afterEach(() => clearRunQueuesForTests());

describe('runQueue', () => {
  it('keeps prompts in the order they were queued', () => {
    enqueuePrompt('s1', 'first');
    enqueuePrompt('s1', 'second');
    enqueuePrompt('s1', 'third');
    expect(shiftQueuedPrompt('s1')?.text).toBe('first');
    expect(shiftQueuedPrompt('s1')?.text).toBe('second');
    expect(getRunQueue('s1').items.map((i) => i.text)).toEqual(['third']);
  });

  it('keeps each chat’s queue apart', () => {
    enqueuePrompt('s1', 'for one');
    enqueuePrompt('s2', 'for two');
    expect(getRunQueue('s1').items.map((i) => i.text)).toEqual(['for one']);
    expect(getRunQueue('s2').items.map((i) => i.text)).toEqual(['for two']);
    pauseRunQueue('s1');
    expect(getRunQueue('s1').paused).toBe(true);
    expect(getRunQueue('s2').paused).toBe(false);
  });

  it('ignores blank prompts', () => {
    expect(enqueuePrompt('s1', '   ')).toBeNull();
    expect(getRunQueue('s1').items).toEqual([]);
  });

  it('pausing keeps every prompt, and an empty queue is never paused', () => {
    pauseRunQueue('s1');
    expect(getRunQueue('s1').paused).toBe(false);
    enqueuePrompt('s1', 'a');
    enqueuePrompt('s1', 'b');
    pauseRunQueue('s1');
    expect(getRunQueue('s1')).toMatchObject({ paused: true });
    expect(getRunQueue('s1').items).toHaveLength(2);
    resumeRunQueue('s1');
    expect(getRunQueue('s1').paused).toBe(false);
  });

  it('removing the last prompt clears the pause', () => {
    const only = enqueuePrompt('s1', 'only')!;
    pauseRunQueue('s1');
    removeQueuedPrompt('s1', only.id);
    expect(getRunQueue('s1')).toEqual({ items: [], paused: false });
  });

  it('take removes one prompt from anywhere in the queue and returns it', () => {
    enqueuePrompt('s1', 'a');
    const b = enqueuePrompt('s1', 'b')!;
    enqueuePrompt('s1', 'c');
    expect(takeQueuedPrompt('s1', b.id)?.text).toBe('b');
    expect(getRunQueue('s1').items.map((i) => i.text)).toEqual(['a', 'c']);
    expect(takeQueuedPrompt('s1', 'missing')).toBeNull();
  });

  it('rekey moves a new chat’s queue to its id and appends to anything already there', () => {
    enqueuePrompt('', 'from the new chat');
    pauseRunQueue('');
    enqueuePrompt('s9', 'already here');
    rekeyRunQueue('', 's9');
    expect(getRunQueue('').items).toEqual([]);
    expect(getRunQueue('s9').items.map((i) => i.text)).toEqual(['already here', 'from the new chat']);
    expect(getRunQueue('s9').paused).toBe(true);
  });

  it('labels chips Next, then Queued 2, 3…, and Paused while paused', () => {
    expect(queueChipLabel(0, false)).toBe('Next');
    expect(queueChipLabel(1, false)).toBe('Queued 2');
    expect(queueChipLabel(2, false)).toBe('Queued 3');
    expect(queueChipLabel(0, true)).toBe('Paused');
    expect(queueChipLabel(1, true)).toBe('Paused');
  });

  it('keeps a queued prompt\'s writing voice', () => {
    const item = enqueuePrompt('voice-chat', 'draft it', 'news');
    expect(item).toMatchObject({ text: 'draft it', voiceId: 'news' });
    expect(shiftQueuedPrompt('voice-chat')).toMatchObject({ voiceId: 'news' });
  });
});

