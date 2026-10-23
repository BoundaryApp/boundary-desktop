import * as net from 'net';

/**
 * Reserves a free TCP port on 127.0.0.1 by binding an ephemeral listen socket, then closing it.
 * The OS guarantees the port was free at assignment time, avoiding naive "scan then use" races.
 */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr?.port) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not allocate port')));
      }
    });
  });
}
