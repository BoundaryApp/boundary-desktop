import { describe, expect, it, vi } from 'vitest';
import { createKeyedRegistry, createRegistry } from '../handlerRegistry';

describe('createRegistry', () => {
  it('calls every handler in order and stops calling one once removed', () => {
    const registry = createRegistry<number>();
    const calls: string[] = [];
    const stopA = registry.add((n) => calls.push(`a${n}`));
    registry.add((n) => calls.push(`b${n}`));
    registry.emit(1, () => undefined);
    stopA();
    registry.emit(2, () => undefined);
    expect(calls).toEqual(['a1', 'b1', 'b2']);
  });

  it('keeps calling handlers after one throws, and reports each error', () => {
    const registry = createRegistry<void>();
    const boom = new TypeError('no');
    const after = vi.fn();
    registry.add(() => {
      throw boom;
    });
    registry.add(after);
    const onError = vi.fn();
    registry.emit(undefined, onError);
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe('createKeyedRegistry', () => {
  it('calls only the handlers for the event’s key', () => {
    const registry = createKeyedRegistry<string>(() => undefined);
    const a = vi.fn();
    const b = vi.fn();
    registry.add('a', a);
    registry.add('b', b);
    registry.emit('a', 'x', () => undefined);
    registry.emit('none', 'y', () => undefined);
    expect(a).toHaveBeenCalledWith('x');
    expect(b).not.toHaveBeenCalled();
  });

  it('reports a change only when a key gains its first handler or loses its last', () => {
    const changed = vi.fn();
    const registry = createKeyedRegistry<void>(changed);
    const stop1 = registry.add('t', () => undefined);
    const stop2 = registry.add('t', () => undefined);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(registry.keys()).toEqual(['t']);
    stop1();
    stop1();
    expect(changed).toHaveBeenCalledTimes(1);
    stop2();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(registry.keys()).toEqual([]);
  });

  it('leaves a re-added key alone when an old unsubscribe runs late', () => {
    const changed = vi.fn();
    const registry = createKeyedRegistry<void>(changed);
    const handler = vi.fn();
    const stop = registry.add('t', handler);
    stop();
    registry.add('t', handler);
    stop();
    expect(registry.keys()).toEqual(['t']);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('keeps calling handlers for a key after one throws', () => {
    const registry = createKeyedRegistry<void>(() => undefined);
    const after = vi.fn();
    registry.add('t', () => {
      throw new Error('no');
    });
    registry.add('t', after);
    const onError = vi.fn();
    registry.emit('t', undefined, onError);
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
