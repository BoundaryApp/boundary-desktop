import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptN8nCredentialData, writeN8nDemoCredentials } from '../n8nCredentials';

/** OpenSSL `enc -d -aes-256-cbc -md md5` for a `Salted__` envelope, written out independently. */
function decrypt(encryptionKey: string, envelope: string): string {
  const raw = Buffer.from(envelope, 'base64');
  expect(raw.subarray(0, 8).toString()).toBe('Salted__');
  const salt = raw.subarray(8, 16);
  const pass = Buffer.concat([Buffer.from(encryptionKey, 'binary'), salt]);
  let prev = Buffer.alloc(0);
  let derived = Buffer.alloc(0);
  while (derived.length < 48) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass])).digest();
    derived = Buffer.concat([derived, prev]);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}

describe('n8n credentials', () => {
  it('encrypts in the OpenSSL salted envelope n8n reads', () => {
    const envelope = encryptN8nCredentialData('k3y', '{"a":1}', Buffer.from('01234567'));
    expect(decrypt('k3y', envelope)).toBe('{"a":1}');
  });

  it('writes both demo credentials with the stack script layout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-n8n-creds-'));
    try {
      const now = new Date('2026-10-22T12:00:00.000Z');
      await writeN8nDemoCredentials(
        root,
        { N8N_ENCRYPTION_KEY: 'enc', LIGHTRAG_API_KEY: 'lr_key', NEO4J_PASSWORD: 'pw' },
        now
      );
      const dir = path.join(root, 'n8n', 'demo-data', 'credentials');
      const lightrag = JSON.parse(fs.readFileSync(path.join(dir, 'LrH7tR4gApiKey01.json'), 'utf8'));
      expect(Object.keys(lightrag)).toEqual([
        'createdAt',
        'updatedAt',
        'id',
        'name',
        'data',
        'type',
        'nodesAccess',
      ]);
      expect(lightrag).toMatchObject({
        createdAt: now.toISOString(),
        name: 'LightRAG API',
        type: 'httpHeaderAuth',
        nodesAccess: [{ nodeType: 'n8n-nodes-base.httpRequest', date: now.toISOString() }],
      });
      expect(JSON.parse(decrypt('enc', lightrag.data))).toEqual({ name: 'X-API-Key', value: 'lr_key' });

      const neo4j = JSON.parse(fs.readFileSync(path.join(dir, 'N34jBas1cAuth001.json'), 'utf8'));
      expect(neo4j.type).toBe('httpBasicAuth');
      expect(JSON.parse(decrypt('enc', neo4j.data))).toEqual({ user: 'neo4j', password: 'pw' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
