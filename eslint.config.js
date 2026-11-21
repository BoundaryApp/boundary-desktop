import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Code that reaches the agent stack goes through the stack host (ADR 0062, remote stack plan
 * 1e): `getStackFiles` or `stackFilesAt` for its files, `StackCommands` for its processes and
 * `getStackEndpoints` for its URLs. These folders may not import `fs` or `child_process`, or
 * write a `127.0.0.1` literal, outside `stackHost/`.
 */
const stackGuardFiles = [
  'src/main/services/assistant/**/*.{ts,tsx}',
  'src/main/services/addons/**/*.{ts,tsx}',
  'src/main/services/hostBridge/**/*.{ts,tsx}',
];

/**
 * Files in those folders that still act on this machine, each with its reason from the remote
 * stack plan. Remove an entry when its file moves to the stack host or behind a capability.
 */
const stackGuardAllowed = [
  // Location resolution and local setup: they find the stack folder and its data root.
  'src/main/services/assistant/assistantPaths.ts',
  'src/main/services/assistant/resolveAssistantRoot.ts',
  'src/main/services/assistant/stackEnv.ts',
  // provision: Boundary installing, upgrading and backing up its own stack. Each checks the
  // capability before it touches the install.
  'src/main/services/assistant/provisionSovereignStack.ts',
  'src/main/services/assistant/runSovereignSetup.ts',
  'src/main/services/assistant/projectTreeSwap.ts',
  'src/main/services/assistant/stackDataBackup.ts',
  // The local host's own compose context; its provisioning and host bridge steps check provision
  // and hostCallbacks.
  'src/main/services/assistant/AssistantStackService.ts',
  // Tools on this machine: ssh-keygen, the Mac calendar helper, `id -F`, Chrome.
  'src/main/services/assistant/hermesWorkerKey.ts',
  'src/main/services/assistant/calendar/macCalendarHelper.ts',
  'src/main/services/addons/addonInstaller.ts',
  'src/main/services/hostBridge/chromePipe.ts',
  // engineControl: probes ports on this machine to size and place the engine; measures nothing
  // without the capability.
  'src/main/services/addons/addonHostFacts.ts',
  // hostFolders: folders on this machine bound into containers, and Boundary's own files under
  // userData beside the stack. Each feature checks the capability before it binds or reads one.
  'src/main/services/assistant/coding/**',
  'src/main/services/assistant/hermes/hermesContextRoots.ts',
  'src/main/services/assistant/hermes/hermesProjects.ts',
  'src/main/services/assistant/hermes/hermesProjectSources.ts',
  'src/main/services/assistant/hermes/hermesProjectsOverlay.ts',
  // The export folder a person picks on this machine (Export history checks hostFolders).
  'src/main/services/assistant/chatHistory/chatHistoryExport.ts',
  // Reveals SOUL.md in Finder, which needs a path on this machine (checks hostFolders).
  'src/main/services/assistant/hermes/hermesAgents.ts',
  // Sample files a person picks on this machine, and revealing a voice's folder in Finder.
  'src/main/services/assistant/writingVoices/writingVoiceSamples.ts',
  'src/main/services/assistant/writingVoices/writingVoicesIpc.ts',
  // Files in project folders on this machine (checks hostFolders), with operations StackFiles
  // lacks: modification times, streamed hashes, file handles.
  'src/main/services/assistant/hermes/projectSourcesModel.ts',
  'src/main/services/assistant/hermes/htmlPreviewFiles.ts',
  'src/main/services/assistant/hermes/writingCheckFiles.ts',
  'src/main/services/assistant/hermes/hermesReplyFiles.ts',
  // Paths `.env` may set anywhere on this machine (ACTUAL_DATA_DIR, TWENTY_PASSWORD_FILE,
  // VIKUNJA_FILES_DIR, BITWARDEN_HOST_DATA_DIR).
  'src/main/services/addons/actualRuntime.ts',
  'src/main/services/addons/twentySignIn.ts',
  'src/main/services/addons/vikunjaAddon.ts',
  'src/main/services/addons/bitwardenFolders.ts',
  // The relay's credential client files go in BITWARDEN_HOST_DATA_DIR's secrets folder (ADR 0065).
  'src/main/services/hostBridge/credentialClient.ts',
  // Loopback checks on a URL someone typed; they build no stack URL.
  'src/main/services/addons/emailAddon.ts',
  'src/main/services/assistant/rewriteLlmUrlForContainer.ts',
  // hostCallbacks: the host bridge listens on this machine and keeps its own files. It doesn't
  // start without the capability.
  'src/main/services/hostBridge/auditLog.ts',
  'src/main/services/hostBridge/bridgeServer.ts',
  'src/main/services/hostBridge/browserConfig.ts',
  'src/main/services/hostBridge/hostBridgeService.ts',
  'src/main/services/hostBridge/requestGuard.ts',
];

const stackGuardMessage =
  'Reach the stack through the stack host (src/main/services/stackHost): getStackFiles or ' +
  'stackFilesAt for files, StackCommands for processes, getStackEndpoints for URLs (ADR 0062).';

const nodeModules = ['fs', 'fs/promises', 'child_process'];

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

/**
 * Experiments may add folders for lint to skip, under `eslint` in their allowances file. Absent
 * from the public repository, where the list is empty.
 */
const experimentAllowances = join(import.meta.dirname, 'src', 'experiments', 'drift-allowances.json');
const experimentIgnores = existsSync(experimentAllowances)
  ? (JSON.parse(readFileSync(experimentAllowances, 'utf8')).eslint ?? [])
  : [];

export default defineConfig([
  globalIgnores([
    'out/**',
    'dist/**',
    'node_modules/**',
    '.claude/**',
    ...experimentIgnores,
  ]),
  {
    // Build and check scripts run in Node and aren't covered by any tsconfig, so only the
    // untyped recommended rules apply.
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    // The Playwright checks pass functions to page.evaluate, which run in the browser.
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
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
    files: stackGuardFiles,
    ignores: [
      ...testFiles,
      'src/main/services/assistant/hermes/vendor/**',
      ...stackGuardAllowed,
    ],
    rules: {
      // Replaces the rule's options from the raw IPC block, so it repeats the electron entry.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', importNames: ['ipcMain', 'ipcRenderer'], message: rawIpcMessage },
            ...nodeModules.flatMap((name) => [
              { name, message: stackGuardMessage },
              { name: `node:${name}`, message: stackGuardMessage },
            ]),
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'Literal[value=/127\\.0\\.0\\.1/]', message: stackGuardMessage },
        { selector: 'TemplateElement[value.raw=/127\\.0\\.0\\.1/]', message: stackGuardMessage },
      ],
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
