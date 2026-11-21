import { describe, expect, it } from 'vitest';
import { parseStackHostLocation, sshLocationLabel } from '../stackHostLocation';

const ssh = {
  kind: 'ssh',
  host: ' pc.example.com ',
  user: 'ana',
  key: { kind: 'file', path: '~/.ssh/id_ed25519' },
  stackFolder: '/srv/stack',
};

describe('parseStackHostLocation', () => {
  it('reads nothing stored as this computer', () => {
    expect(parseStackHostLocation(undefined)).toEqual({ location: { kind: 'local' } });
    expect(parseStackHostLocation({ kind: 'local' })).toEqual({ location: { kind: 'local' } });
  });

  it('reads an SSH location, trimming its names', () => {
    expect(parseStackHostLocation({ ...ssh, port: 2222, hostKeyFingerprint: 'SHA256:abc' })).toEqual({
      location: { ...ssh, host: 'pc.example.com', port: 2222, hostKeyFingerprint: 'SHA256:abc' },
    });
    expect(parseStackHostLocation({ ...ssh, key: { kind: 'agent' } })).toEqual({
      location: { ...ssh, host: 'pc.example.com', key: { kind: 'agent' } },
    });
  });

  it.each([
    ['a string', 'ssh://pc'],
    ['an unknown kind', { kind: 'vm' }],
    ['no user', { ...ssh, user: '' }],
    ['a bad port', { ...ssh, port: 70000 }],
    ['no key', { ...ssh, key: { kind: 'keychain' } }],
    ['a relative stack folder', { ...ssh, stackFolder: 'stack' }],
    ['a fingerprint in another form', { ...ssh, hostKeyFingerprint: 'MD5:aa' }],
  ])('refuses %s rather than reading it as this computer', (_name, value) => {
    expect(parseStackHostLocation(value)).toHaveProperty('error');
  });
});

describe('sshLocationLabel', () => {
  it('names the port only when it isn’t 22', () => {
    expect(sshLocationLabel({ user: 'ana', host: 'pc', port: 22 })).toBe('ana@pc');
    expect(sshLocationLabel({ user: 'ana', host: 'pc', port: 2222 })).toBe('ana@pc:2222');
  });
});
