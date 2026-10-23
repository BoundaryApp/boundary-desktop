import http from 'node:http';
import { allocateLoopbackPort } from './allocateLoopbackPort';

export interface OAuthLoopbackResult {
  code: string;
  port: number;
}

export interface StartOAuthLoopbackOptions {
  timeoutMs?: number;
  preferredPort?: number;
  signal?: AbortSignal;
}

export async function startOAuthLoopbackServer(
  options: StartOAuthLoopbackOptions = {}
): Promise<{ port: number; waitForCode: () => Promise<OAuthLoopbackResult> }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const port = options.preferredPort ?? (await allocateLoopbackPort());

  let server: http.Server | null = null;
  let settled = false;

  const waitForCode = (): Promise<OAuthLoopbackResult> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth authorization timed out. Try again.'));
      }, timeoutMs);

      const onAbort = () => {
        cleanup();
        reject(new Error('OAuth authorization was cancelled.'));
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        server?.close();
        server = null;
      };

      server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing callback URL.');
          return;
        }

        const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        const code = requestUrl.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><p>Missing authorization code.</p></body></html>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><p>Authorization complete. You can close this tab and return to Boundary.</p></body></html>'
        );

        cleanup();
        resolve({ code, port });
      });

      server.on('error', (error) => {
        cleanup();
        reject(error);
      });

      server.listen(port, '127.0.0.1');
    });

  return { port, waitForCode };
}
