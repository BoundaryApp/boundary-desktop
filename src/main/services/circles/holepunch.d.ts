/**
 * The parts of the Holepunch modules that the Circles network process uses. The packages ship
 * no type declarations; these follow their READMEs and sources at the versions in package.json.
 */

declare module 'corestore' {
  import type { EventEmitter } from 'node:events';
  import type { SecretStream } from 'hyperswarm';

  /** A Hypercore as Corestore hands it out; Boundary doesn't depend on `hypercore` directly. */
  export interface Hypercore extends EventEmitter {
    readonly key: Buffer;
    readonly discoveryKey: Buffer;
    readonly length: number;
    /** The length a majority of the Autobase's indexers have signed; blocks before it won't move. */
    readonly signedLength: number;
    readonly writable: boolean;
    ready(): Promise<void>;
    setUserData(key: string, value: Buffer | null): Promise<void>;
    close(): Promise<void>;
    append(block: Buffer | string): Promise<{ length: number }>;
    get(index: number): Promise<Buffer | null>;
    update(opts?: { wait?: boolean }): Promise<boolean>;
    /** Marks a peer search as running; call the returned function when it ends. */
    findingPeers(): () => void;
  }

  export default class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>);
    ready(): Promise<void>;
    get(opts: { name: string } | { key: Buffer; active?: boolean }): Hypercore;
    namespace(name: string): Corestore;
    /** Deletes these cores from storage; `force` includes cores with open sessions. */
    purge(keys: Buffer[], opts?: { force?: boolean }): Promise<Buffer[]>;
    replicate(stream: SecretStream): unknown;
    close(): Promise<void>;
  }
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  import type { Duplex } from 'node:stream';

  interface PeerDiscovery {
    flushed(): Promise<void>;
  }

  /**
   * A connection: `@hyperswarm/secret-stream` over a udx-native stream. Unordered messages arrive
   * as `message` events with a Buffer.
   */
  /** The UDX stream under a connection; read for diagnostics only. */
  export interface UdxStream {
    readonly remoteHost: string | null;
    readonly remotePort: number;
    readonly rtt: number;
    readonly retransmits: number;
    readonly bytesTransmitted: number;
    readonly bytesReceived: number;
    readonly packetsTransmitted: number;
    readonly packetsReceived: number;
  }

  /** HyperDHT's view of this device's network; read for diagnostics only. */
  export interface DhtState extends EventEmitter {
    readonly host: string | null;
    readonly port: number;
    readonly firewalled: boolean;
    readonly randomized: boolean;
    readonly ephemeral: boolean;
  }

  export interface SecretStream extends Duplex {
    readonly opened: Promise<boolean>;
    readonly isInitiator: boolean;
    readonly rawStream: UdxStream | null;
    /** Sends one encrypted UDP datagram: no acknowledgement, retransmission or ordering. */
    trySend(buffer: Buffer): void;
  }

  export interface PeerInfo {
    readonly publicKey: Buffer;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: { bootstrap?: string[]; keyPair?: { publicKey: Buffer; secretKey: Buffer } });
    readonly connections: Set<SecretStream>;
    readonly dht: DhtState;
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): PeerDiscovery;
    flush(): Promise<void>;
    leave(topic: Buffer): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (connection: SecretStream, peer: PeerInfo) => void): this;
  }
}

declare module 'autobase' {
  import type { EventEmitter } from 'node:events';
  import type Corestore from 'corestore';
  import type { Hypercore } from 'corestore';

  export interface AutobaseNode {
    readonly value: unknown;
    /** False for a node the indexers have not yet ordered (`lib/apply-state.js`). */
    readonly indexed: boolean;
    /** The writer core that appended it. */
    readonly from: { key: Buffer };
  }

  export interface AutobaseHost {
    addWriter(key: Buffer, opts: { indexer: boolean }): Promise<void>;
    removeWriter(key: Buffer): Promise<void>;
    removeable(key: Buffer): boolean;
    /** Throws, ending this apply; the base then emits `interrupt` and appends fail. */
    interrupt(reason: string): void;
  }

  export default class Autobase<View = Hypercore> extends EventEmitter {
    constructor(
      store: Corestore,
      bootstrap: Buffer | null,
      opts: {
        open: (store: Corestore) => View;
        apply: (nodes: AutobaseNode[], view: View, host: AutobaseHost) => Promise<void>;
        valueEncoding?: string;
        encrypt?: boolean;
        encryptionKey?: Buffer;
        ackInterval?: number;
      }
    );
    static getLocalCore(store: Corestore): Hypercore & { close(): Promise<void> };
    readonly key: Buffer;
    readonly discoveryKey: Buffer;
    readonly encryptionKey: Buffer | null;
    readonly local: Hypercore | null;
    readonly view: View;
    readonly isIndexer: boolean;
    readonly writable: boolean;
    readonly signedLength: number;
    /** The system view, once open: the current indexers' writer keys. */
    readonly system: {
      readonly indexers: ReadonlyArray<{ key: Buffer }>;
      /** Every writer the system has seen, removed ones included. */
      list(): AsyncIterable<{ key: Buffer }>;
    } | null;
    /** The system core. */
    readonly core: Hypercore;
    /** Private to Autobase, but its only list of the view cores (`lib/store.js`). */
    readonly _viewStore: { getViews(): Array<{ core: Hypercore | null }> };
    ready(): Promise<void>;
    append(value: unknown): Promise<void>;
    update(): Promise<void>;
    close(): Promise<void>;
  }
}

declare module 'hyperbee' {
  import type { Hypercore } from 'corestore';

  export default class Hyperbee {
    readonly core: Hypercore;
    constructor(core: Hypercore, opts?: { keyEncoding?: string; valueEncoding?: string; extension?: boolean });
    ready(): Promise<void>;
    get(key: string): Promise<{ key: string; value: unknown } | null>;
    put(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
    createReadStream(range?: { gt?: string; gte?: string; lt?: string; lte?: string }): AsyncIterable<{
      /** The entry's block in the core, which `signedLength` is compared with. */
      seq: number;
      key: string;
      value: unknown;
    }>;
  }
}

declare module 'hypercore-crypto' {
  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }
  const crypto: {
    keyPair(seed?: Buffer): KeyPair;
    sign(message: Buffer, secretKey: Buffer): Buffer;
    verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean;
    randomBytes(n: number): Buffer;
    discoveryKey(key: Buffer): Buffer;
  };
  export default crypto;
}

declare module 'z32' {
  const z32: { encode(buf: Buffer): string; decode(text: string): Buffer };
  export default z32;
}

declare module 'blind-pairing' {
  import type { EventEmitter } from 'node:events';
  import type Hyperswarm from 'hyperswarm';

  /** The admin's view of a candidate (blind-pairing-core `MemberRequest`). */
  export interface MemberRequest {
    readonly inviteId: Buffer;
    /** Set by `open`. */
    readonly userData: Buffer | null;
    open(publicKey: Buffer): Buffer;
    confirm(result: { key: Buffer; encryptionKey?: Buffer; additional?: unknown }): void;
    /** Status 1 rejected, 2 used, 3 expired; the candidate's request emits `rejected`. */
    deny(opts?: { status?: number }): void;
  }

  export interface BlindMember {
    flushed(): Promise<void>;
    close(): Promise<void>;
  }

  export interface BlindCandidate {
    /** Resolves with the result once paired, or null when closed first. */
    readonly pairing: Promise<{ key: Buffer; encryptionKey: Buffer } | null>;
    readonly request: EventEmitter;
    close(): Promise<void>;
  }

  export default class BlindPairing {
    constructor(swarm: Hyperswarm, opts?: { poll?: number });
    static createInvite(
      key: Buffer,
      opts?: { expires?: number }
    ): { id: Buffer; invite: Buffer; publicKey: Buffer; expires: number };
    addMember(opts: { discoveryKey: Buffer; onadd: (candidate: MemberRequest) => Promise<void> }): BlindMember;
    addCandidate(opts: {
      invite: Buffer;
      userData: Buffer;
      onadd?: (result: { key: Buffer; encryptionKey: Buffer }) => Promise<void>;
    }): BlindCandidate;
    close(): Promise<void>;
  }
}

declare module 'hyperdht/testnet.js' {
  interface Testnet {
    readonly bootstrap: Array<{ host: string; port: number }>;
    destroy(): Promise<void>;
  }
  export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module 'compact-encoding' {
  export interface State {
    start: number;
    end: number;
    buffer: Buffer | null;
  }
  export interface Encoding<T> {
    preencode(state: State, value: T): void;
    encode(state: State, value: T): void;
    decode(state: State): T;
  }
  export const uint: Encoding<number>;
  export const buffer: Encoding<Buffer | null>;
  export const json: Encoding<unknown>;
}

declare module 'protomux' {
  import type { Encoding } from 'compact-encoding';
  import type { SecretStream } from 'hyperswarm';

  export interface ProtomuxMessage<T> {
    send(value: T): boolean;
  }

  export interface ProtomuxChannel {
    readonly opened: boolean;
    readonly closed: boolean;
    readonly messages: Array<ProtomuxMessage<never>>;
    open(handshake?: unknown): void;
    /** Resolves true once both sides have opened it, false if it closed first. */
    fullyOpened(): Promise<boolean>;
    close(): void;
    addMessage<T>(opts: { encoding: Encoding<T>; onmessage: (value: T) => void }): ProtomuxMessage<T>;
  }

  /** One muxer per stream; Corestore's replication shares it. */
  export default class Protomux {
    static from(stream: SecretStream): Protomux;
    /** Called when the remote opens `protocol` and no local channel is waiting for it. */
    pair(opts: { protocol: string; id?: Buffer | null }, notify: () => void | Promise<void>): void;
    createChannel(opts: {
      protocol: string;
      id?: Buffer | null;
      unique?: boolean;
      onopen?: () => void;
      onclose?: (isRemote: boolean) => void;
    }): ProtomuxChannel | null;
  }
}
