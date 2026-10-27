import debug from 'debug';

/** Every logger's namespace starts with this, so the dev scripts' `DEBUG=boundary:*` enables them all. */
const NAMESPACE_ROOT = 'boundary';

/**
 * Main passes its `DEBUG` value to the window with this argument
 * (`webPreferences.additionalArguments`), because preload and renderer don't see the
 * main process's environment.
 */
const DEBUG_ARG_PREFIX = '--boundary-debug=';

/** The argument that carries `env.DEBUG` to a window. An empty value turns logging off there. */
export function debugArgForWindow(env: NodeJS.ProcessEnv = process.env): string {
  return `${DEBUG_ARG_PREFIX}${env.DEBUG ?? ''}`;
}

/**
 * Apply the `DEBUG` value main passed in argv. In preload, `debug`'s browser build stores it in
 * `localStorage.debug`, where the renderer's copy of `debug` reads it when it loads. Main has no
 * such argument and reads `DEBUG` from its environment.
 */
export function enableDebugFromArgv(argv: readonly string[] | undefined): void {
  const arg = argv?.find((value) => value.startsWith(DEBUG_ARG_PREFIX));
  if (arg === undefined) return;
  debug.enable(arg.slice(DEBUG_ARG_PREFIX.length));
}

enableDebugFromArgv(typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : undefined);

/**
 * Creates a debug logger named `boundary:<name>`. The name is `customNamespace` when given
 * (a leading `boundary:` in it is not repeated), else the file path with colons for slashes.
 *
 * @param filePath - The file path (usually __filename or import.meta.url)
 * @param customNamespace - Optional name to use instead of the file path
 * @returns A debug logger function
 */
function createLogger(filePath: string | undefined, customNamespace?: string): debug.Debugger {
  let name: string;
  if (customNamespace) {
    name = customNamespace.replace(new RegExp(`^${NAMESPACE_ROOT}:`), '');
  } else if (filePath) {
    name = filePath
      // Remove the project root path
      .replace(/^.*\/boundary-desktop\//, '')
      // Remove file extension
      .replace(/\.[^/.]+$/, '')
      // Replace path separators with colons
      .replace(/\//g, ':');
  } else {
    name = 'unknown';
  }
  return debug(`${NAMESPACE_ROOT}:${name}`);
}

/**
 * Creates a debug logger for the current file in ESM environments
 * Usage: const log = createFileLogger(import.meta.url);
 * 
 * @param importMetaUrl - The import.meta.url from the current file
 * @param customNamespace - Optional custom namespace to append
 * @returns A debug logger function
 */
export function createFileLogger(importMetaUrl?: string, customNamespace?: string): debug.Debugger {
  let filePath: string | undefined;
  
  if (importMetaUrl) {
    // Always use URL parsing to avoid require() issues in ES modules
    filePath = extractPathFromUrl(importMetaUrl);
  }
  
  return createLogger(filePath, customNamespace);
}

/**
 * Extract a meaningful file path from import.meta.url
 * Works in both Node.js and browser environments
 */
function extractPathFromUrl(importMetaUrl: string): string {
  try {
    const url = new URL(importMetaUrl);
    const pathname = url.pathname;
    
    // Extract the last part of the path as a meaningful name
    const segments = pathname.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] || 'unknown';
    
    // Remove extension and return
    return fileName.replace(/\.[^/.]+$/, '');
  } catch (error) {
    console.warn('Failed to parse import.meta.url:', error);
    return 'unknown';
  }
}
