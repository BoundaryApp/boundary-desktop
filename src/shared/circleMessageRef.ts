import type { CircleMessageRef } from './types/circles';

/** A message's name as `author/id` (ADR 0042 §4); also the value of a row's `data-message`. */
export const refKey = (ref: CircleMessageRef): string => `${ref.author}/${ref.id}`;

export const sameRef = (a: CircleMessageRef, b: CircleMessageRef): boolean => a.author === b.author && a.id === b.id;

/** Selects the rendered row of the message with this key or ref. */
export const messageRowSelector = (ref: CircleMessageRef | string): string =>
  `[data-message="${typeof ref === 'string' ? ref : refKey(ref)}"]`;
