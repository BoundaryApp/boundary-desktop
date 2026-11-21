import net from 'node:net';
import type { Duplex } from 'node:stream';

/** Opens a connection from the remote host to `host:port` there; `SshConnection.forwardOut`. */
export type ForwardOut = (host: string, port: number) => Promise<Duplex>;

export interface PortForwards {
  /**
   * Listens on a free port on this machine's loopback and carries each connection to
   * `host:port` on the remote host. Forwarding the same remote port again gives the same local
   * port.
   */
  forward(host: string, port: number): Promise<number>;
  /** The local port that reaches `remotePort`, or undefined when it isn't forwarded. */
  localPort(remotePort: number): number | undefined;
  /** Stops listening and ends every connection that is open. */
  close(): Promise<void>;
}

const LOOPBACK = '127.0.0.1';

/** Local forwards over one SSH connection, as `ssh -L 0:host:port` makes for each port. */
export function portForwards(forwardOut: ForwardOut): PortForwards {
  const byRemotePort = new Map<number, { server: net.Server; local: number }>();
  const pending = new Map<number, Promise<number>>();
  const open = new Set<Duplex>();
  let closed = false;

  const carry = (socket: net.Socket, host: string, port: number) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    forwardOut(host, port).then(
      (channel) => {
        if (socket.destroyed || closed) {
          channel.destroy();
          return;
        }
        open.add(channel);
        channel.once('close', () => {
          open.delete(channel);
          socket.destroy();
        });
        channel.on('error', () => channel.destroy());
        socket.once('close', () => channel.destroy());
        socket.pipe(channel).pipe(socket);
      },
      // The host refused (nothing listening, forwarding turned off): the client sees a reset.
      () => socket.destroy()
    );
  };

  const listen = (host: string, port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((socket) => carry(socket, host, port));
      server.once('error', reject);
      server.listen(0, LOOPBACK, () => {
        const local = (server.address() as net.AddressInfo).port;
        byRemotePort.set(port, { server, local });
        resolve(local);
      });
    });

  return {
    forward(host, port) {
      if (closed) return Promise.reject(new Error('The SSH port forwards are closed'));
      const existing = byRemotePort.get(port);
      if (existing) return Promise.resolve(existing.local);
      let started = pending.get(port);
      if (!started) {
        started = listen(host, port).finally(() => pending.delete(port));
        pending.set(port, started);
      }
      return started;
    },
    localPort: (remotePort) => byRemotePort.get(remotePort)?.local,
    async close() {
      closed = true;
      await Promise.allSettled(pending.values());
      for (const stream of open) stream.destroy();
      await Promise.all(
        [...byRemotePort.values()].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
      byRemotePort.clear();
    },
  };
}
