import path from 'path';
import os from 'os';
import { vi } from 'vitest';

const memoryStores: Record<string, Record<string, unknown>> = {};

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation((options?: { name?: string; defaults?: Record<string, unknown> }) => {
    const name = options?.name ?? 'default';
    if (!memoryStores[name]) {
      memoryStores[name] = { ...(options?.defaults ?? {}) };
    }
    const data = memoryStores[name];
    return {
      get: (key: string) => data[key],
      set: (key: string, value: unknown) => {
        if (value === undefined) {
          delete data[key];
        } else {
          data[key] = value;
        }
      },
      delete: (key: string) => {
        delete data[key];
      },
      clear: () => {
        for (const key of Object.keys(data)) {
          delete data[key];
        }
        Object.assign(data, options?.defaults ?? {});
      },
      get store() {
        return data;
      },
    };
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return path.join(os.tmpdir(), 'boundary-desktop-vitest-userdata');
      }
      return path.join(os.tmpdir(), 'boundary-electron-mock', name);
    },
    getAppPath: () => path.join(os.tmpdir(), 'boundary-electron-mock', 'app'),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
}));
