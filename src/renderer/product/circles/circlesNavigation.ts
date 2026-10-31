import { useEffect, useRef } from 'react';

/** Open Sharing, with a person's panel when `person` names their identity. */
export interface OpenCirclesRequest {
  person?: string;
}

const OPEN_CIRCLES_EVENT = 'boundary:open-circles';

/** Ask the ready shell to show Sharing, e.g. from a toast or a chat that stopped. */
export function openCircles(request: OpenCirclesRequest = {}): void {
  window.dispatchEvent(new CustomEvent<OpenCirclesRequest>(OPEN_CIRCLES_EVENT, { detail: request }));
}

export function useOpenCirclesRequests(handler: (request: OpenCirclesRequest) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (event: Event) => handlerRef.current((event as CustomEvent<OpenCirclesRequest>).detail);
    window.addEventListener(OPEN_CIRCLES_EVENT, listener);
    return () => window.removeEventListener(OPEN_CIRCLES_EVENT, listener);
  }, []);
}
