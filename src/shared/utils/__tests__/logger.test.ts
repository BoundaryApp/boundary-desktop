import debug from 'debug';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileLogger, debugArgForWindow, enableDebugFromArgv } from '../logger';

// import.meta.url of main-process code at runtime: everything is bundled into one index.js.
const BUNDLE_URL = 'file:///Applications/Boundary.app/Contents/Resources/app.asar/.vite/build/index.js';

const callSites = () => ({
  main: createFileLogger(BUNDLE_URL),
  dbConnection: createFileLogger(BUNDLE_URL, 'boundary:main:db:connection'),
  preload: createFileLogger(undefined, 'preload'),
  renderer: createFileLogger(undefined, 'renderer:debug'),
});

describe('logger namespaces', () => {
  afterEach(() => {
    debug.disable();
  });

  it('puts every call site under boundary:', () => {
    expect(Object.values(callSites()).map((log) => log.namespace)).toEqual([
      'boundary:index',
      'boundary:main:db:connection',
      'boundary:preload',
      'boundary:renderer:debug',
    ]);
  });

  it('enables every call site with the dev scripts\' DEBUG=boundary:*', () => {
    debug.enable('boundary:*');
    expect(Object.values(callSites()).every((log) => log.enabled)).toBe(true);
  });

  it('applies the DEBUG value main passes to a window in argv', () => {
    enableDebugFromArgv(['electron', debugArgForWindow({ DEBUG: 'boundary:*' })]);
    expect(createFileLogger(undefined, 'preload').enabled).toBe(true);

    enableDebugFromArgv(['electron', debugArgForWindow({})]);
    expect(createFileLogger(undefined, 'preload').enabled).toBe(false);
  });

  it('leaves the setting alone when argv has no DEBUG argument', () => {
    debug.enable('boundary:*');
    enableDebugFromArgv(['electron', '--other']);
    expect(createFileLogger(undefined, 'preload').enabled).toBe(true);
  });
});
