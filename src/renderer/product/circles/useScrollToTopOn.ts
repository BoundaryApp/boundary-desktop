import { useLayoutEffect, type RefObject } from 'react';

/**
 * Scrolls an element back to its top, before paint, whenever `key` changes. For a scroller whose
 * node stays mounted while its content is another Circle's.
 */
export function useScrollToTopOn(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [ref, key]);
}
