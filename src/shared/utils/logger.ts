import debug from 'debug';

/**
 * Creates a debug logger with a namespace based on the file path
 * Path segments are separated by colons as requested
 * 
 * @param filePath - The file path (usually __filename or import.meta.url)
 * @param customNamespace - Optional custom namespace to append
 * @returns A debug logger function
 */
export function createLogger(filePath: string | undefined, customNamespace?: string): debug.Debugger {
  // Handle cases where filePath might be undefined (browser environment)
  if (!filePath) {
    // Fallback to a generic namespace for browser environments
    const namespace = customNamespace ? `browser:${customNamespace}` : 'browser:unknown';
    return debug(namespace);
  }

  // Convert file path to namespace
  let namespace = filePath
    // Remove the project root path
    .replace(/^.*\/boundary-desktop\//, '')
    // Remove file extension
    .replace(/\.[^/.]+$/, '')
    // Replace path separators with colons
    .replace(/\//g, ':');
  
  // Add custom namespace if provided
  if (customNamespace) {
    namespace += `:${customNamespace}`;
  }
  
  return debug(namespace);
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

/**
 * Creates a debug logger with a custom namespace for the current file
 * Usage: const log = createFileLoggerWithNamespace(import.meta.url, 'my-feature');
 * 
 * @param importMetaUrl - The import.meta.url from the current file
 * @param customNamespace - Custom namespace to append
 * @returns A debug logger function
 */
export function createFileLoggerWithNamespace(importMetaUrl: string, customNamespace: string): debug.Debugger {
  return createFileLogger(importMetaUrl, customNamespace);
}

/**
 * Helper function to create a logger for the current file in ESM
 * This is the recommended way to create loggers in ESM environments
 * Usage: const log = createESMLogger(import.meta.url);
 * 
 * @param importMetaUrl - The import.meta.url from the current file
 * @param customNamespace - Optional custom namespace to append
 * @returns A debug logger function
 */
export function createESMLogger(importMetaUrl: string, customNamespace?: string): debug.Debugger {
  return createFileLogger(importMetaUrl, customNamespace);
}
