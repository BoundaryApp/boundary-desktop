import { describe, expect, it } from 'vitest';
import { describeStartupError } from '../../../../shared/startupErrors';
import { python3SetupError } from '../../../../main/services/assistant/runSovereignSetup';

describe('describeStartupError', () => {
  it.each([
    ['Compose exited with code 1: Error response from daemon: write /var/lib: no space left on device', 'disk'],
    ['Compose exited with code 1: Bind for 0.0.0.0:8642 failed: port is already allocated', 'port'],
    ['listen tcp 127.0.0.1:7474: bind: address already in use', 'port'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'runtime'],
    ['Error: boundary already starting or running: only one VM can be active at a time', 'runtime'],
    ['Error response from daemon: toomanyrequests: You have reached your pull rate limit.', 'rate-limit'],
    ['Failed to download agent stack archive (404 Not Found): https://example.com/a.zip', 'download'],
    ['fetch failed', 'network'],
    ['Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host', 'network'],
    ['The agent stack download didn’t match its pinned checksum (expected a, got b): https://example.com', 'checksum'],
    ['Couldn’t stop the agent stack before upgrading it: timeout', 'upgrade'],
    ['Hermes API did not become healthy at http://127.0.0.1:8642/health within 180000ms', 'health'],
    ['Compose timed out after 10 minutes: {"id":"Container boundary-hermes"}\n/opt/data/config.yaml', 'slow-start'],
    ['setup.sh exited with code 2.\nsomething', 'setup'],
    ['Compose exited with code 1: service "n8n" exited', 'compose'],
    ['Something nobody planned for', 'unknown'],
  ])('reads %s as %s', (raw, kind) => {
    expect(describeStartupError(raw).kind).toBe(kind);
  });

  it('keeps messages that were already written for users', () => {
    const raw = python3SetupError('missing');
    const described = describeStartupError(raw);
    expect(described.kind).toBe('python');
    expect(described.body).toBe(raw);
  });

  it('handles a missing message', () => {
    expect(describeStartupError(undefined).kind).toBe('unknown');
  });
});
