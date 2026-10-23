import { defineConfig } from 'drizzle-kit';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

// NOTE: This config is only used for development and CLI operations.
// In the Electron app, the config is generated dynamically in connection.ts
// when the app is ready and userData path is available.

// Get the user data directory for the app (only works when app is ready)
let userDataPath: string;
let dbDir: string;
let dbPath: string;

try {
  userDataPath = app.getPath('userData');
  dbDir = path.join(userDataPath, 'db');
  dbPath = path.join(dbDir, 'boundary.db');

  console.log('userDataPath', userDataPath);
  console.log('dbDir', dbDir);
  console.log('dbPath', dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
} catch (error) {
  // Fallback for when app is not ready (development only)
  console.warn('App not ready, using fallback paths for development');
  dbDir = path.join(process.cwd(), 'db');
  dbPath = path.join(dbDir, 'boundary.db');
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

export default defineConfig({
  out: dbDir,
  schema: './schema/Task.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: `file:${dbPath}`,
  },
});