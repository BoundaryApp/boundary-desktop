import type { ChildProcess } from 'node:child_process';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import fs from 'node:fs';
import path from 'node:path';

/** Project root — forge.config.ts always lives at the workspace root. */
const projectRoot = process.cwd();

/**
 * Vite externalizes native / heavy Node packages, but Forge's Vite plugin does not
 * copy node_modules into the asar. Copy those packages (and production deps) after
 * packager's file copy so runtime `require()` / `import` can resolve them.
 * @see https://github.com/electron/forge/issues/3738
 */
const VITE_EXTERNAL_PACKAGE_ROOTS = [
  'better-sqlite3',
  'dockerode',
  'ssh2',
] as const;

function readPackageJson(packageName: string, fromDir: string): { dependencies?: Record<string, string> } | null {
  const direct = path.join(fromDir, 'node_modules', ...packageName.split('/'), 'package.json');
  if (fs.existsSync(direct)) {
    return JSON.parse(fs.readFileSync(direct, 'utf8')) as { dependencies?: Record<string, string> };
  }
  return null;
}

function collectPackageTree(roots: readonly string[], sourceRoot: string): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const pkg = readPackageJson(name, sourceRoot);
    if (!pkg?.dependencies) continue;
    for (const dep of Object.keys(pkg.dependencies)) {
      queue.push(dep);
    }
  }
  return [...seen];
}

async function copyViteExternalPackages(buildPath: string): Promise<string[]> {
  const sourceRoot = projectRoot;
  const sourceNodeModules = path.join(sourceRoot, 'node_modules');
  const destNodeModules = path.join(buildPath, 'node_modules');
  const packages = collectPackageTree(VITE_EXTERNAL_PACKAGE_ROOTS, sourceRoot);
  const copied: string[] = [];
  const missing: string[] = [];

  await fs.promises.mkdir(destNodeModules, { recursive: true });

  for (const packageName of packages) {
    const relParts = packageName.split('/');
    const sourcePath = path.join(sourceNodeModules, ...relParts);
    const destPath = path.join(destNodeModules, ...relParts);
    if (!fs.existsSync(sourcePath)) {
      missing.push(packageName);
      continue;
    }
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.cp(sourcePath, destPath, {
      recursive: true,
      preserveTimestamps: true,
    });
    copied.push(packageName);
  }

  if (missing.length > 0) {
    console.warn('[forge] Missing packages while copying Vite externals:', missing.join(', '));
  }

  return copied;
}

/** Private experiments, one folder each; absent from the public repository. */
const experimentsDir = path.join(projectRoot, 'src', 'experiments');

/**
 * Copy each experiment's `resources/` entries next to the extra resources (outside asar), where
 * the packaged app looks for them. Skip `.terraform` provider caches; Terraform inits those in
 * the instance workspace.
 */
async function copyExperimentResources(buildPath: string): Promise<void> {
  if (!fs.existsSync(experimentsDir)) return;
  const experiments = await fs.promises.readdir(experimentsDir, { withFileTypes: true });
  for (const experiment of experiments) {
    if (!experiment.isDirectory()) continue;
    const source = path.join(experimentsDir, experiment.name, 'resources');
    if (!fs.existsSync(source)) continue;
    for (const entry of await fs.promises.readdir(source)) {
      await fs.promises.cp(path.join(source, entry), path.join(buildPath, '..', entry), {
        recursive: true,
        preserveTimestamps: true,
        filter: (srcPath) => !srcPath.split(path.sep).includes('.terraform'),
      });
    }
  }
}

const appleId = process.env.APPLE_ID;
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const appleTeamId = process.env.APPLE_TEAM_ID;
const canNotarize = Boolean(appleId && appleIdPassword && appleTeamId);
// Enable signing in CI (OSX_SIGN=1 / CSC_NAME) or whenever notarize credentials are present.
// Omit locally so unsigned `make` / `dist:mac` still succeed without a Developer ID.
const shouldSign = Boolean(
  process.env.OSX_SIGN === '1' ||
    process.env.OSX_SIGN === 'true' ||
    process.env.CSC_NAME ||
    canNotarize
);

const config: ForgeConfig = {
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      await copyViteExternalPackages(buildPath);
      await copyExperimentResources(buildPath);
    },
    postStart: async (_config, child: ChildProcess) => {
      let forgeExiting = false;
      const exitForge = (code: number) => {
        if (forgeExiting) return;
        forgeExiting = true;
        process.exit(code);
      };

      child.on('exit', (code) => {
        exitForge(code ?? 0);
      });

      const killChildAndExitForge = (signal: 'SIGINT' | 'SIGTERM') => {
        if (child.exitCode !== null) {
          exitForge(signal === 'SIGINT' ? 130 : 143);
          return;
        }
        child.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
          exitForge(signal === 'SIGINT' ? 130 : 143);
        }, 5000);
        forceKillTimer.unref();
      };

      process.on('SIGINT', () => killChildAndExitForge('SIGINT'));
      process.on('SIGTERM', () => killChildAndExitForge('SIGTERM'));
    },
  },
  packagerConfig: {
    // Unpack native .node binaries; AutoUnpackNativesPlugin expands this further.
    asar: {
      unpack: '**/*.{node,dylib,dll,so}',
    },
    // macOS app metadata
    appBundleId: 'com.boundary.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    // Ensure proper app name and metadata
    appCopyright: '© 2025-2026 Keith Axline',
    // appVersion and buildVersion default to package.json's version, which releases are cut from.
    // Icon configuration for macOS
    icon: 'src/assets/icon.icns',
    // Podman/compose helpers must live outside the asar (executable + notarization).
    // Populate via ./scripts/fetch-container-runtime.sh before packaging.
    // Assistant compose overlay ships beside container-runtime for stack ownership.
    // Third-party licence texts ship in Resources/licenses.
    extraResource: ['./resources/container-runtime', './resources/assistant', './resources/licenses'],
    ...(shouldSign
      ? {
          // CSC_NAME selects a specific identity; otherwise osx-sign auto-selects Developer ID.
          osxSign: {
            ...(process.env.CSC_NAME ? { identity: process.env.CSC_NAME } : {}),
            // krunkit/vfkit need hypervisor + virtualization. Signing them with
            // the Electron-only entitlements causes Hardened Runtime abort trap.
            optionsForFile: (filePath: string) => {
              const isContainerHelper = filePath.includes(
                `${path.sep}container-runtime${path.sep}`
              );
              return {
                entitlements: isContainerHelper
                  ? path.join(
                      projectRoot,
                      'build/entitlements.mac.container-helper.plist'
                    )
                  : path.join(projectRoot, 'build/entitlements.mac.plist'),
                hardenedRuntime: true,
              };
            },
          },
        }
      : {}),
    // Skip notarization when Apple credentials are unset (local unsigned builds).
    ...(canNotarize
      ? {
          osxNotarize: {
            appleId: appleId!,
            appleIdPassword: appleIdPassword!,
            teamId: appleTeamId!,
          },
        }
      : {}),
  },
  // Rebuild nothing. better-sqlite3 ships N-API prebuilds that load in both Node and Electron.
  // ssh2's crypto addon and cpu-features are optional: @electron/rebuild skips ssh2's (its
  // binding.gyp isn't at the package root) and doesn't produce cpu-features, and ssh2 falls back
  // to JS crypto without either. An empty list also stops Forge rewriting .node files in place.
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Host bridge utilityProcess (ADR 0027), forked by hostBridgeService.ts.
          entry: 'src/main/services/hostBridge/bridgeProcess.ts',
          config: 'vite.hostBridge.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
