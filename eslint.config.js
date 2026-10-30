import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Files tsconfig.json leaves out, so type-aware rules can't run on them. Tests are exempt anyway. */
const testFiles = [
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.test.{ts,tsx}',
  '**/vitest.*.ts',
  '**/*.config.ts',
];

/**
 * The typed IPC helpers (ADR 0031 §4): main registers with `handle`/`handleResult` and sends
 * with `sendEvent` (src/main/ipc.ts) or `broadcast` (src/main/services/windows.ts); preload
 * builds bridge leaves with `invoker`/`listen` (src/preloadIpc.ts). Channels and payloads are
 * typed in src/shared/ipc/channels.ts.
 */
const ipcHelperFiles = ['src/main/ipc.ts', 'src/preloadIpc.ts'];

/**
 * Files allowed raw IPC. This list may only shrink: fix new findings instead of adding entries.
 */
const rawIpcAllowed = [
  // Dev instrumentation outside the channel map: it patches ipcMain.handle to time every
  // handler, and its reports are fire-and-forget sends with no typed helper.
  'src/main/perf/lagProbe.ts',
  'src/preloadLagProbe.ts',
];

const rawIpcMessage =
  'Use the typed IPC helpers: handle/handleResult/sendEvent (src/main/ipc.ts), broadcast ' +
  '(src/main/services/windows.ts), or invoker/listen (src/preloadIpc.ts).';

/** Methods that send to a renderer without the channel map's types. */
const rawSendMethods = new Set(['send', 'sendToFrame', 'postMessage']);

/**
 * Flags `.send(...)`, `.sendToFrame(...)` and `.postMessage(...)` on a WebContents or
 * WebFrameMain, and `.reply(...)` on an IpcMainEvent, whatever the variable is called. Needs
 * type information; files without it are skipped.
 */
const noRawRendererSend = {
  meta: { type: 'problem', schema: [], messages: { raw: rawIpcMessage } },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program) return {};
    const checker = services.program.getTypeChecker();
    const typeName = (node) => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker.getNonNullableType(checker.getTypeAtLocation(tsNode)).getSymbol()?.getName();
    };
    return {
      'CallExpression > MemberExpression.callee[computed=false]'(node) {
        const method = node.property.name;
        if (rawSendMethods.has(method)) {
          const name = typeName(node.object);
          if (name === 'WebContents' || name === 'WebFrameMain') context.report({ node, messageId: 'raw' });
        } else if (method === 'reply' && typeName(node.object) === 'IpcMainEvent') {
          context.report({ node, messageId: 'raw' });
        }
      },
    };
  },
};

export default defineConfig([
  globalIgnores([
    'private/**',
    'out/**',
    'dist/**',
    'node_modules/**',
    '.claude/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      importX.flatConfigs.recommended,
      importX.flatConfigs.electron,
      importX.flatConfigs.typescript,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // typescript-eslint 5 recommended had these as warnings; 6+ made them errors.
      '@typescript-eslint/no-explicit-any': 'warn',
      // A leading underscore marks a value left unused on purpose: an ignored parameter, or a
      // key dropped from an object with rest destructuring.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Test doubles stand in for loosely typed Electron, IPC and store objects.
    files: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Type information for the code in tsconfig.json, which the rules here and below need.
    files: ['src/**/*.{ts,tsx}'],
    ignores: testFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // Every conditional use in src was an in-flight or cached promise, kept in a
      // `Promise | null` variable and tested for truthiness to reuse it, so conditionals are not
      // checked. Promise-returning callbacks where a void one is expected still are.
      '@typescript-eslint/no-misused-promises': ['error', { checksConditionals: false }],
      // A `default` does not count as covering a union's remaining members: list them, so
      // adding a member flags each switch that has to decide about it.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [...testFiles, ...ipcHelperFiles, ...rawIpcAllowed],
    plugins: { boundary: { rules: { 'no-raw-renderer-send': noRawRendererSend } } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', importNames: ['ipcMain', 'ipcRenderer'], message: rawIpcMessage },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'electron', property: 'ipcMain', message: rawIpcMessage },
        { object: 'electron', property: 'ipcRenderer', message: rawIpcMessage },
      ],
      'boundary/no-raw-renderer-send': 'error',
    },
  },
  {
    files: ['src/main/**/*.{ts,tsx}'],
    ignores: testFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Vendored upstream sources keep their @ts-nocheck headers so they can be re-synced as-is.
    files: ['src/main/services/assistant/hermes/vendor/**'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
]);
