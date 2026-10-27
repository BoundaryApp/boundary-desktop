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
    { type: 'files', file: 'src/renderer/components/ui/progress.tsx', reason },
    { type: 'files', file: 'src/renderer/onboarding/OnboardingContext.tsx', reason },
    { type: 'exports', file: 'src/renderer/components/ui/badge.tsx', symbol: 'Badge', reason },
    { type: 'exports', file: 'src/main/services/onboarding/onboardingExtensions.ts', symbol: 'registerOnboardingExtension', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'isOpenAiConfigEncryptionAvailable', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'getPendingProviderSetup', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'setPendingProviderSetup', reason },
    { type: 'exports', file: 'src/main/services/onboarding/OpenAiOnboardingStore.ts', symbol: 'clearPendingProviderSetup', reason },
    { type: 'exports', file: 'src/shared/llmConnectionDefaults.ts', symbol: 'INFRASTRUCTURE_LLM_CAPABILITIES', reason },
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
    // Loaded by import.meta.glob in src/main/experiments.ts, src/preloadExperiments.ts and
    // src/renderer/experiments.ts, which knip does not follow.
    ...(hasExperiments ? [`${experiments}/*/{main,preload,renderer}.ts`] : []),
  ],
  project: ['src/**/*.{ts,tsx,css}', 'scripts/**/*.{js,mjs}', '*.ts'],
  // Forge's build entries (main, preload, host bridge, renderer index.html) come from the
  // vite.*.config.ts files forge.config.ts names, which knip's Vite plugin reads.
  vitest: {
    config: [
      'vitest.config.ts',
      'src/main/vitest.main-services.config.ts',
      'src/main/vitest.stack.config.ts',
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
    // Used only by experiments; unused in a tree without them.
    ...(hasExperiments
      ? []
      : ['@radix-ui/react-progress', 'better-sqlite3', 'drizzle-orm', 'zod', '@types/better-sqlite3']),
  ],
  treatConfigHintsAsErrors: true,
  preprocessor: './scripts/knip-allowances.mjs',
  preprocessorOptions: { allow: [...allow, ...allowExperiments] },
};
