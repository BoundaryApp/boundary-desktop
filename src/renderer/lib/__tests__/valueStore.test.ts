import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAW_STRING_CODEC, createStoredValue, createValueStore } from '../valueStore';

describe('createValueStore', () => {
  it('holds a value, tells subscribers when it changes, and renders it', () => {
    const store = createValueStore(1);
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    const { result } = renderHook(() => store.use());
    expect(result.current).toBe(1);
    act(() => store.set(2));
    expect(store.get()).toBe(2);
    expect(result.current).toBe(2);
    expect(heard).toHaveBeenCalledTimes(1);
    store.set(2);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    store.set(3);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('resets to its first value', () => {
    const store = createValueStore('a');
    store.set('b');
    store.reset();
    expect(store.get()).toBe('a');
  });
});

describe('createStoredValue', () => {
  const isWord = (value: unknown): value is string => typeof value === 'string' && /^[a-z]+$/.test(value);
  afterEach(() => window.localStorage.clear());

  it('reads its value from storage when first asked and writes each change back', () => {
    window.localStorage.setItem('test:word', JSON.stringify('kept'));
    const store = createStoredValue('test:word', 'none', isWord);
    expect(store.get()).toBe('kept');
    store.set('other');
    expect(JSON.parse(window.localStorage.getItem('test:word') ?? 'null')).toBe('other');
  });

  it('falls back when storage holds nothing, junk or a value it does not accept', () => {
    const store = createStoredValue('test:word', 'none', isWord);
    expect(store.get()).toBe('none');
    window.localStorage.setItem('test:word', '{not json');
    store.reset();
    expect(store.get()).toBe('none');
    window.localStorage.setItem('test:word', JSON.stringify(42));
    store.reset();
    expect(store.get()).toBe('none');
  });

  it('reads storage again after a reset', () => {
    const store = createStoredValue('test:word', 'none', isWord);
    expect(store.get()).toBe('none');
    window.localStorage.setItem('test:word', JSON.stringify('later'));
    store.reset();
    expect(store.get()).toBe('later');
  });

  it('reads and writes unquoted strings with the raw codec', () => {
    window.localStorage.setItem('test:word', 'kept');
    const store = createStoredValue('test:word', 'none', isWord, RAW_STRING_CODEC);
    expect(store.get()).toBe('kept');
    store.set('other');
    expect(window.localStorage.getItem('test:word')).toBe('other');
    window.localStorage.setItem('test:word', 'Not A Word');
    store.reset();
    expect(store.get()).toBe('none');
  });
});
