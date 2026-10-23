import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type N8nCredentialSecrets = {
  N8N_ENCRYPTION_KEY: string;
  LIGHTRAG_API_KEY: string;
  NEO4J_PASSWORD?: string;
  NEO4J_USERNAME?: string;
};

/**
 * n8n's credential envelope: OpenSSL `Salted__` + salt + AES-256-CBC ciphertext, base64,
 * with key and IV derived by EVP_BytesToKey (MD5). Same as the stack's
 * scripts/generate-n8n-credentials.js.
 */
export function encryptN8nCredentialData(
  encryptionKey: string,
  data: string,
  salt: Buffer = crypto.randomBytes(8)
): string {
  const password = Buffer.concat([Buffer.from(encryptionKey, 'binary'), salt]);
  const hash1 = crypto.createHash('md5').update(password).digest();
  const hash2 = crypto.createHash('md5').update(Buffer.concat([hash1, password])).digest();
  const hash3 = crypto.createHash('md5').update(Buffer.concat([hash2, password])).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.concat([hash1, hash2]), hash3);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64');
}

/**
 * Write n8n/demo-data/credentials/*.json, as the stack's generate-n8n-credentials.js does,
 * so first run doesn't need Node on the host. Returns the files written.
 */
export async function writeN8nDemoCredentials(
  projectRoot: string,
  secrets: N8nCredentialSecrets,
  now: Date = new Date()
): Promise<string[]> {
  const outDir = path.join(projectRoot, 'n8n', 'demo-data', 'credentials');
  const timestamp = now.toISOString();
  const encrypt = (value: unknown) =>
    encryptN8nCredentialData(secrets.N8N_ENCRYPTION_KEY, JSON.stringify(value));
  const docs = [
    {
      id: 'LrH7tR4gApiKey01',
      name: 'LightRAG API',
      type: 'httpHeaderAuth',
      data: encrypt({ name: 'X-API-Key', value: secrets.LIGHTRAG_API_KEY }),
    },
    {
      id: 'N34jBas1cAuth001',
      name: 'Neo4j',
      type: 'httpBasicAuth',
      data: encrypt({
        user: secrets.NEO4J_USERNAME || 'neo4j',
        password: secrets.NEO4J_PASSWORD || 'change-me-please',
      }),
    },
  ];

  await fs.promises.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const doc of docs) {
    const filePath = path.join(outDir, `${doc.id}.json`);
    const payload = {
      createdAt: timestamp,
      updatedAt: timestamp,
      id: doc.id,
      name: doc.name,
      data: doc.data,
      type: doc.type,
      nodesAccess: [{ nodeType: 'n8n-nodes-base.httpRequest', date: timestamp }],
    };
    await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    written.push(filePath);
  }
  return written;
}
