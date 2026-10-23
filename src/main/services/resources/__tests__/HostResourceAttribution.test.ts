import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../../shared/assistantStackConstants';
import {
  composeHostResourceSnapshot,
  dockerCpuShare,
  isAssistantStackContainer,
  llmDiskDirectories,
  parseNetstatListenPid,
  parsePodmanMachineMemoryBytes,
  parseWindowsProcessSample,
  sampleHostResources,
  walkDirectoryBytes,
  type HostResourceProbes,
} from '../HostResourceAttribution';

const HOST = {
  displayName: 'This Mac',
  cpuCores: 10,
  memoryBytes: 32 * 1024 ** 3,
  diskBytes: 512 * 1024 ** 3,
};

function gib(n: number): number {
  return n * 1024 * 1024 * 1024;
}

describe('isAssistantStackContainer', () => {
  it('matches the Boundary compose project label', () => {
    expect(
      isAssistantStackContainer(
        { 'com.docker.compose.project': BOUNDARY_ASSISTANT_PROJECT_NAME },
        'boundary-n8n-postgres',
        { localMode: false, assistantRoot: null }
      )
    ).toBe(true);
  });

  it('matches local-stack working dir and unprefixed names', () => {
    expect(
      isAssistantStackContainer(
        { 'com.docker.compose.project.working_dir': '/Users/me/assistant' },
        'hermes',
        { localMode: true, assistantRoot: '/Users/me/assistant' }
      )
    ).toBe(true);
    expect(
      isAssistantStackContainer({}, 'lightrag', {
        localMode: true,
        assistantRoot: '/Users/me/assistant',
      })
    ).toBe(true);
    expect(
      isAssistantStackContainer({}, 'lightrag', {
        localMode: false,
        assistantRoot: '/Users/me/assistant',
      })
    ).toBe(false);
  });

  it('matches extra-profile working dirs under the assistant root', () => {
    expect(
      isAssistantStackContainer(
        {
          'com.docker.compose.project': 'sovereign-agent-stack',
          'com.docker.compose.project.working_dir': '/Users/me/assistant/compose/ollama',
          'com.docker.compose.service': 'ollama',
        },
        'ollama',
        { localMode: true, assistantRoot: '/Users/me/assistant' }
      )
    ).toBe(true);
  });

  it('matches local-stack service labels when the container was renamed', () => {
    expect(
      isAssistantStackContainer(
        { 'com.docker.compose.service': 'signal' },
        'custom-sidecar',
        { localMode: true, assistantRoot: '/Users/me/assistant' }
      )
    ).toBe(true);
  });

  it('does not steal another compose project named hermes', () => {
    expect(
      isAssistantStackContainer(
        {
          'com.docker.compose.project': 'notes-api',
          'com.docker.compose.service': 'hermes',
        },
        'hermes',
        { localMode: true, assistantRoot: '/Users/me/assistant' }
      )
    ).toBe(false);
  });
});

describe('composeHostResourceSnapshot', () => {
  it('derives rest as host minus measured buckets', () => {
    const snapshot = composeHostResourceSnapshot({
      host: HOST,
      app: { cpuShare: 0.04, memoryBytes: gib(0.8) },
      stack: { cpuShare: 0.11, memoryBytes: gib(4.2), running: true },
      llm: { cpuShare: 0.37, memoryBytes: gib(8.6), detected: true, detail: 'Ollama on :11434' },
      disk: { app: gib(2.1), stack: gib(18.4), llm: gib(42) },
    });
    expect(snapshot.buckets.rest.status).toBe('estimated');
    expect(snapshot.buckets.rest.cpuShare).toBeCloseTo(0.48, 5);
    expect(snapshot.buckets.rest.memoryBytes).toBeCloseTo(gib(18.4), 0);
    expect(snapshot.buckets.rest.diskBytes).toBeCloseTo(gib(449.5), -4);
    expect(snapshot.buckets.rest.detail).toMatch(/Estimated/);
  });

  it('collapses LLM to not-detected while keeping disk', () => {
    const snapshot = composeHostResourceSnapshot({
      host: HOST,
      app: { cpuShare: 0.05, memoryBytes: gib(0.8) },
      stack: { cpuShare: 0.12, memoryBytes: gib(4.2), running: true },
      llm: { cpuShare: 0.4, memoryBytes: gib(8), detected: false, detail: 'ignored' },
      disk: { app: gib(2.1), stack: gib(18.4), llm: gib(42) },
    });
    expect(snapshot.buckets.llm.status).toBe('not-detected');
    expect(snapshot.buckets.llm.cpuShare).toBe(0);
    expect(snapshot.buckets.llm.memoryBytes).toBe(0);
    expect(snapshot.buckets.llm.diskBytes).toBe(gib(42));
    expect(snapshot.buckets.llm.detail).toBe('not detected');
    expect(snapshot.buckets.rest.cpuShare).toBeCloseTo(0.83, 5);
  });

  it('collapses a down stack to not-running while keeping disk', () => {
    const snapshot = composeHostResourceSnapshot({
      host: HOST,
      app: { cpuShare: 0.04, memoryBytes: gib(0.8) },
      stack: { cpuShare: 0.2, memoryBytes: gib(4), running: false },
      llm: { cpuShare: 0.41, memoryBytes: gib(8.6), detected: true, detail: 'Ollama on :11434' },
      disk: { app: gib(2.1), stack: gib(18.4), llm: gib(42) },
      localMode: true,
    });
    expect(snapshot.buckets.stack.status).toBe('not-running');
    expect(snapshot.buckets.stack.cpuShare).toBe(0);
    expect(snapshot.buckets.stack.memoryBytes).toBe(0);
    expect(snapshot.buckets.stack.diskBytes).toBe(gib(18.4));
    expect(snapshot.buckets.rest.cpuShare).toBeCloseTo(0.55, 5);
  });

  it('clamps rest when measured shares exceed the host', () => {
    const snapshot = composeHostResourceSnapshot({
      host: HOST,
      app: { cpuShare: 0.6, memoryBytes: gib(20) },
      stack: { cpuShare: 0.6, memoryBytes: gib(20), running: true },
      llm: { cpuShare: 0.6, memoryBytes: gib(20), detected: true, detail: 'Ollama' },
      disk: { app: gib(200), stack: gib(200), llm: gib(200) },
    });
    expect(snapshot.buckets.rest.cpuShare).toBe(0);
    expect(snapshot.buckets.rest.memoryBytes).toBe(0);
    expect(snapshot.buckets.rest.diskBytes).toBe(0);
    expect(snapshot.caveats.some((line) => /clamped/i.test(line))).toBe(true);
  });

  it('marks rest warming when disk is not ready', () => {
    const snapshot = composeHostResourceSnapshot({
      host: HOST,
      app: { cpuShare: 0.04, memoryBytes: gib(0.8) },
      stack: { cpuShare: 0.11, memoryBytes: gib(4.2), running: true },
      llm: { cpuShare: 0.37, memoryBytes: gib(8.6), detected: true, detail: 'Ollama on :11434' },
      disk: { app: null, stack: null, llm: null },
    });
    expect(snapshot.buckets.rest.status).toBe('warming');
    expect(snapshot.buckets.rest.diskBytes).toBeNull();
    expect(snapshot.caveats.some((line) => /warming/i.test(line))).toBe(true);
  });
});

describe('llmDiskDirectories', () => {
  it('includes Ollama and LM Studio model homes', () => {
    expect(llmDiskDirectories('/Users/me', 'darwin')).toEqual([
      '/Users/me/.ollama',
      '/Users/me/.lmstudio/models',
      '/Users/me/Library/Application Support/LM Studio/models',
    ]);
    expect(llmDiskDirectories('C:\\Users\\me', 'win32')).toContain(
      path.join('C:\\Users\\me', 'Documents', 'LM Studio', 'models')
    );
  });
});

describe('walkDirectoryBytes', () => {
  it('sums nested files and treats a missing path as empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'boundary-disk-'));
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'a.bin'), Buffer.alloc(128));
    await writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(64));
    expect(await walkDirectoryBytes(root)).toBe(192);
    expect(await walkDirectoryBytes(path.join(root, 'missing'))).toBe(0);
  });
});

describe('Windows listen-PID parsers', () => {
  it('reads the LISTENING pid for a TCP port from netstat', () => {
    const stdout = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888',
      '  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       4242',
      '  TCP    [::]:1234              [::]:0                 LISTENING       99',
    ].join('\r\n');
    expect(parseNetstatListenPid(stdout, 11434)).toBe(4242);
    expect(parseNetstatListenPid(stdout, 1234)).toBe(99);
    expect(parseNetstatListenPid(stdout, 9999)).toBeNull();
  });

  it('sums WorkingSet and percent CPU from Windows process rows', () => {
    const sample = parseWindowsProcessSample('4242,1048576,20\r\n4243,524288,10\r\n', 10);
    expect(sample.memoryBytes).toBe(1048576 + 524288);
    expect(sample.cpuShare).toBeCloseTo(0.03, 5);
  });
});

describe('dockerCpuShare', () => {
  it('converts a one-core-busy container on 10 cores to 0.1', () => {
    expect(
      dockerCpuShare(
        {
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
          cpu_stats: {
            cpu_usage: { total_usage: 1_000_000, percpu_usage: [1] },
            system_cpu_usage: 1_000_000,
            online_cpus: 1,
          },
        },
        10
      )
    ).toBeCloseTo(0.1, 5);
  });
});

describe('sampleHostResources', () => {
  function probes(overrides: Partial<HostResourceProbes> = {}): HostResourceProbes {
    return {
      getHostname: () => 'This Mac',
      getCpuCoreCount: () => 10,
      getTotalMemoryBytes: () => HOST.memoryBytes,
      getTotalDiskBytes: async () => HOST.diskBytes,
      sampleElectron: async () => ({ cpuShare: 0.04, memoryBytes: gib(0.8) }),
      listAssistantContainers: async () => [
        {
          id: 'c1',
          name: 'boundary-hermes',
          labels: { 'com.docker.compose.project': BOUNDARY_ASSISTANT_PROJECT_NAME },
        },
      ],
      sampleContainer: async () => ({ cpuShare: 0.11, memoryBytes: gib(4.2) }),
      discoverLocalLlmPorts: async () => [
        { runtime: 'ollama', displayName: 'Ollama', port: 11434 },
      ],
      resolveListenPid: async () => 4242,
      samplePids: async () => ({ cpuShare: 0.37, memoryBytes: gib(8.6) }),
      getDiskUsage: async () => ({ app: gib(2.1), stack: gib(18.4), llm: gib(42) }),
      isLocalStackMode: () => false,
      getAssistantRoot: () => '/tmp/assistant',
      ...overrides,
    };
  }

  it('samples a typical load through injected probes', async () => {
    const snapshot = await sampleHostResources(probes());
    expect(snapshot.buckets.app.cpuShare).toBeCloseTo(0.04);
    expect(snapshot.buckets.stack.status).toBe('measured');
    expect(snapshot.buckets.llm.detail).toBe('Ollama on :11434');
    expect(snapshot.buckets.rest.cpuShare).toBeCloseTo(0.48, 5);
  });

  it('uses local-stack name fallback when listing unprefixed containers', async () => {
    const snapshot = await sampleHostResources(
      probes({
        isLocalStackMode: () => true,
        listAssistantContainers: async () => [
          { id: 'c1', name: 'hermes', labels: {} },
        ],
        sampleContainer: async () => ({ cpuShare: 0.08, memoryBytes: gib(3) }),
      })
    );
    expect(snapshot.buckets.stack.status).toBe('measured');
    expect(snapshot.buckets.stack.detail).toMatch(/local assistant stack/);
    expect(snapshot.buckets.stack.cpuShare).toBeCloseTo(0.08);
  });

  it('treats an empty container list as stack down', async () => {
    const snapshot = await sampleHostResources(
      probes({
        listAssistantContainers: async () => [],
      })
    );
    expect(snapshot.buckets.stack.status).toBe('not-running');
    expect(snapshot.buckets.stack.cpuShare).toBe(0);
  });

  it('treats no LLM endpoints as not detected', async () => {
    const snapshot = await sampleHostResources(
      probes({
        discoverLocalLlmPorts: async () => [],
      })
    );
    expect(snapshot.buckets.llm.status).toBe('not-detected');
    expect(snapshot.buckets.llm.cpuShare).toBe(0);
    expect(snapshot.buckets.llm.diskBytes).toBe(gib(42));
  });

  it('adds a reserved-memory footnote without a fifth bucket', async () => {
    const snapshot = await sampleHostResources(
      probes({
        getEngineVmReservedBytes: async () => 8 * 1024 ** 3,
      })
    );
    expect(snapshot.caveats.some((line) => /Podman machine boundary reserved 8 GB/i.test(line))).toBe(
      true
    );
    expect(snapshot.caveats.some((line) => /not a fifth bucket/i.test(line))).toBe(true);
    expect(Object.keys(snapshot.buckets)).toEqual(['app', 'stack', 'llm', 'rest']);
  });
});

describe('parsePodmanMachineMemoryBytes', () => {
  it('reads Resources.Memory as MiB', () => {
    expect(
      parsePodmanMachineMemoryBytes(JSON.stringify({ Resources: { Memory: 12288 } }))
    ).toBe(12288 * 1024 * 1024);
    expect(parsePodmanMachineMemoryBytes('not-json')).toBeNull();
  });
});
