import { EventEmitter } from 'node:events';

type ProgressListener = (message: string) => void;

const emitter = new EventEmitter();
let lastMessage: string | null = null;

export function setRuntimeProvisionProgress(message: string): void {
  lastMessage = message;
  emitter.emit('progress', message);
}

export function clearRuntimeProvisionProgress(): void {
  lastMessage = null;
}

export function getRuntimeProvisionProgress(): string | null {
  return lastMessage;
}

export function onRuntimeProvisionProgress(listener: ProgressListener): () => void {
  emitter.on('progress', listener);
  return () => emitter.off('progress', listener);
}
