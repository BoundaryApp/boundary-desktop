import { useEffect, useRef } from 'react';

/** Open Inference, at a person's row in From your Circles when `person` names their identity. */
export interface OpenInferenceRequest {
  person?: string;
}

const OPEN_INFERENCE_EVENT = 'boundary:open-inference';

/** Ask the ready shell to show Inference: links about a model land there (ADR 0043 §6). */
export function openInference(request: OpenInferenceRequest = {}): void {
  window.dispatchEvent(new CustomEvent<OpenInferenceRequest>(OPEN_INFERENCE_EVENT, { detail: request }));
}

export function useOpenInferenceRequests(handler: (request: OpenInferenceRequest) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (event: Event) => handlerRef.current((event as CustomEvent<OpenInferenceRequest>).detail);
    window.addEventListener(OPEN_INFERENCE_EVENT, listener);
    return () => window.removeEventListener(OPEN_INFERENCE_EVENT, listener);
  }, []);
}
