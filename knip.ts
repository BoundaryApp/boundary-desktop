import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Unused files, exports and dependencies (ADR 0031 §4). `bun run check:unused` runs it; CI fails
 * on any finding that is not in `allow` below, and on any `allow` entry that no longer matches.
 */

/** Private experiments sit beside main/ and are absent from the public repository. */
const experiments = join('src', 'experiments');
const hasExperiments = existsSync(join(import.meta.dirname, experiments));

type Allowance = { type: string; file: string; symbol?: string; reason: string };

/**
 * Findings kept on purpose: `type` is a knip issue type, `file` the path from the repository
 * root, `symbol` the export (omitted for `files`). This list may only shrink: remove an entry
 * when its code goes, and fix new findings instead of adding entries. scripts/knip-allowances.mjs
 * applies it and fails on entries that match nothing.
 */
const allow: Allowance[] = [
  // shadcn/ui components (components.json): each file keeps the generator's full export list.
  { type: 'exports', file: 'src/renderer/components/ui/alert.tsx', symbol: 'alertVariants', reason: 'shadcn/ui component API' },
  { type: 'exports', file: 'src/renderer/components/ui/badge.tsx', symbol: 'badgeVariants', reason: 'shadcn/ui component API' },
  { type: 'exports', file: 'src/renderer/components/ui/button.tsx', symbol: 'buttonVariants', reason: 'shadcn/ui component API' },
  { type: 'exports', file: 'src/renderer/components/ui/select.tsx', symbol: 'SelectScrollDownButton', reason: 'shadcn/ui component API' },
  { type: 'exports', file: 'src/renderer/components/ui/select.tsx', symbol: 'SelectScrollUpButton', reason: 'shadcn/ui component API' },
  ...(hasExperiments
    ? [{ type: 'exports', file: 'src/renderer/components/ui/card.tsx', symbol: 'CardAction', reason: 'shadcn/ui component API' }]
    : withoutExperiments()),
];

/**
 * Code that only experiments use: extension points they register through, and components and
 * helpers they import. Unused in a tree without them, such as the public repository.
 */
function withoutExperiments(): Allowance[] {
  const reason = 'Used only by experiments, which this tree does not have.';
  return [
    { type: 'files', file: 'src/renderer/components/ui/card.tsx', reason },
    { type: 'files', file: 'src/renderer/onboarding/OnboardingContext.tsx', reason },
    { type: 'exports', file: 'src/main/services/onboarding/onboardingExtensions.ts', symbol: 'registerOnboardingExtension', reason },
    { type: 'exports', file: 'src/main/services/inference/askChatModelOnce.ts', symbol: 'askChatModelOnce', reason },
    { type: 'exports', file: 'src/main/services/inference/askChatModelOnce.ts', symbol: 'chatModelReady', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'isOpenAiConfigEncryptionAvailable', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'getPendingProviderSetup', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'setPendingProviderSetup', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'clearPendingProviderSetup', reason },
    { type: 'exports', file: 'src/shared/llmConnectionDefaults.ts', symbol: 'INFRASTRUCTURE_LLM_CAPABILITIES', reason },
    { type: 'exports', file: 'src/main/services/assistant/hermes/builtinAgentName.ts', symbol: 'notifyBuiltinAgentNameChanged', reason },
    // Host API names (src/main/host, src/renderer/host, src/preloadHost.ts) only experiments use.
    { type: 'files', file: 'src/main/host/experiments.ts', reason },
    { type: 'files', file: 'src/preloadHost.ts', reason },
    { type: 'exports', file: 'src/main/host/log.ts', symbol: 'fileStatForLog', reason },
    { type: 'exports', file: 'src/main/host/log.ts', symbol: 'serializeError', reason },
    { type: 'exports', file: 'src/main/host/storage.ts', symbol: 'decryptFromBase64', reason },
    { type: 'exports', file: 'src/main/host/storage.ts', symbol: 'replaceCiphertext', reason },
    { type: 'exports', file: 'src/main/host/storage.ts', symbol: 'redactSecrets', reason },
    { type: 'exports', file: 'src/main/host/windows.ts', symbol: 'getMainWindow', reason },
    { type: 'exports', file: 'src/main/host/windows.ts', symbol: 'showMainWindow', reason },
    { type: 'exports', file: 'src/main/host/windows.ts', symbol: 'heldNotification', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'BuiltinAgentMarkProps', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'BuiltinAgentPortraitProps', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'HomeRowProps', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'ProviderSetupViewProps', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'RendererExperiment', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'RingFigureProps', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'SetupFlowSnapshot', reason },
    { type: 'types', file: 'src/renderer/host/experiments.ts', symbol: 'SetupStepProps', reason },
  ];
}

/** Experiments keep their own allowances, in the same form, beside their code. */
const experimentAllowances = join(import.meta.dirname, experiments, 'drift-allowances.json');
const allowExperiments: Allowance[] = existsSync(experimentAllowances)
  ? (JSON.parse(readFileSync(experimentAllowances, 'utf8')).knip ?? [])
  : [];

export default {
  entry: [
    'scripts/*.{js,mjs}',
    // Loaded by import.meta.glob in src/main/experiments.ts, src/preloadExperiments.ts,
    // src/renderer/experiments.ts and scripts/ui-screenshot/harness.tsx, which knip does not follow.
    ...(hasExperiments ? [`${experiments}/*/{main,preload,renderer,screenshot}.ts`] : []),
  ],
  project: ['src/**/*.{ts,tsx,css}', 'scripts/**/*.{js,mjs}', '*.ts'],
  // Forge's build entries (main, preload, host bridge, renderer index.html) come from the
  // vite.*.config.ts files forge.config.ts names, which knip's Vite plugin reads.
  vitest: {
    config: [
      'vitest.config.ts',
      'src/main/vitest.main-services.config.ts',
      'src/main/vitest.stack.config.ts',
      'src/main/vitest.circles.config.ts',
      'src/main/vitest.live.config.ts',
      'src/renderer/vitest.renderer-unit.config.ts',
    ],
  },
  // Not the drizzle plugin: it would load the experiment's drizzle config, which creates folders.
  drizzle: false,
  ignoreIssues: {
    // Vendored from the gateway's TypeScript client and re-synced as-is; treated as generated.
    'src/main/services/assistant/hermes/vendor/**': ['exports', 'types', 'files'],
  },
  // A type exported beside the code whose signature uses it is part of that module's interface.
  ignoreExportsUsedInFile: { interface: true, type: true },
  // Dependencies may only shrink too: knip reports an entry here that no longer matches.
  ignoreDependencies: [
    // Imported by a store test; installed by electron-store.
    'conf',
    // Type import in forge.config.ts; installed by @electron-forge/cli.
    '@electron-forge/shared-types',
    // Run as a CLI against an experiment's drizzle config, which knip does not load (above).
    'drizzle-kit',
    // Loaded by file path (dist/wasm.js and privatemode.wasm), since its exports map offers neither.
    'privatemode-ai',
    // Used only by experiments; unused in a tree without them.
    ...(hasExperiments
      ? []
      : ['better-sqlite3', 'drizzle-orm', 'zod', '@types/better-sqlite3', 'phaser']),
  ],
  // The Swift toolchain, used by test:calendar-helper; it ships with Xcode, not npm. ffmpeg
  // encodes the demo in screenshot:ui; the Screenshot workflow installs it with Homebrew.
  // mkfifo is the POSIX tool htmlPreviewFiles.test.ts uses to make a FIFO.
  ignoreBinaries: ['swift', 'ffmpeg', 'mkfifo', 'ssh-keygen'],
  treatConfigHintsAsErrors: true,
  preprocessor: './scripts/knip-allowances.mjs',
  preprocessorOptions: { allow: [...allow, ...allowExperiments] },
};
