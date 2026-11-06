import Docker from 'dockerode';
import { EventEmitter } from 'events';
import type { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { dockerodeOptionsFromApiEndpoint, getContainerRuntime } from './containerRuntime';

export interface DockerComposeConfig {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting' | 'stopping';
  services: DockerServiceInfo[];
  path: string;
  lastUpdated: string;
}

export interface DockerServiceInfo {
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting' | 'stopping';
  image: string;
  ports: string[];
  health: 'healthy' | 'unhealthy' | 'starting' | 'unknown';
}

const COMPOSE_FILE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Container events in a burst wait this long and share one refresh. */
export const EVENT_REFRESH_DELAY_MS = 500;

/**
 * Container actions that can't change a compose project's services, status or health.
 * Health checks alone send exec_create, exec_start and exec_die every few seconds for each
 * container that has one; refreshing on each of those ran hundreds of file checks a second.
 */
const IGNORED_CONTAINER_ACTIONS = new Set(['attach', 'detach', 'resize', 'top', 'archive-path', 'extract-to-dir', 'export', 'copy']);

/** Whether a Docker event can change the compose configs. Actions can carry detail after ': '. */
export function isComposeRelevantEvent(event: { Type?: string; Action?: string }): boolean {
  if (event.Type !== 'container') return false;
  const action = (event.Action ?? '').split(':')[0].trim();
  return !action.startsWith('exec_') && !IGNORED_CONTAINER_ACTIONS.has(action);
}

class DockerService extends EventEmitter {
  private docker: Docker | null = null;
  private isConnected = false;
  private eventStream: NodeJS.ReadableStream | null = null;
  private configCache: Map<string, DockerComposeConfig> = new Map();
  private refreshInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private eventRefreshTimer: NodeJS.Timeout | null = null;
  private eventBuffer: string = ''; // Buffer for incomplete JSON events
  private initPromise: Promise<void> | null = null;

  constructor() {
    super();
    // Deliberately do not open a Docker socket at import/construct time.
  }

  /**
   * Ensure the dockerode client is connected. Safe to call repeatedly.
   */
  async ensureReady(): Promise<boolean> {
    await this.initializeDocker();
    return this.isConnected;
  }

  private async getClient(): Promise<Docker | null> {
    await this.ensureReady();
    return this.docker;
  }

  private async initializeDocker() {
    if (this.isConnected && this.docker) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      try {
        const runtime = await getContainerRuntime();
        this.docker = new Docker(dockerodeOptionsFromApiEndpoint(runtime.apiEndpoint));
        await this.docker.ping();
        this.isConnected = true;
        console.log('Docker service initialized successfully');

        // startEventStream catches and logs its own failures.
        void this.startEventStream();
        this.startPeriodicRefresh();

        this.emit('connected');
      } catch (error) {
        console.error('Failed to initialize Docker service:', error);
        this.isConnected = false;
        this.docker = null;
        this.emit('error', error);
      } finally {
        this.initPromise = null;
      }
    })();

    await this.initPromise;
  }

  private async startEventStream() {
    if (!this.docker || !this.isConnected) return;

    try {
      this.eventStream = await this.docker.getEvents({
        filters: {
          type: ['container', 'image', 'network', 'volume']
        }
      });

      this.eventStream.on('data', (chunk) => {
        try {
          const data = chunk.toString();
          // Add new data to buffer
          this.eventBuffer += data;
          
          // Safety check: prevent buffer from growing too large
          if (this.eventBuffer.length > 1024 * 1024) { // 1MB limit
            console.warn('Docker event buffer too large, clearing');
            this.eventBuffer = '';
            return;
          }
          
          // Process complete events (separated by newlines)
          const lines = this.eventBuffer.split('\n');
          
          // Keep the last line in buffer (it might be incomplete)
          this.eventBuffer = lines.pop() || '';
          
          // Process complete lines
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '') continue;
            
            try {
              const event = JSON.parse(trimmedLine);
              this.handleDockerEvent(event);
            } catch (parseError) {
              // Only log if the line looks like it should be valid JSON
              if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
                console.error('Error parsing individual Docker event:', parseError, 'Data:', trimmedLine);
              } else {
                // This might be a partial event, which is expected with buffering
                // (Silently skip partial event data)
              }
            }
          }
        } catch (error) {
          console.error('Error processing Docker event chunk:', error);
        }
      });

      this.eventStream.on('error', (error) => {
        console.error('Docker event stream error:', error);
        this.reconnectEventStream();
      });

      this.eventStream.on('end', () => {
        console.log('Docker event stream ended');
        this.reconnectEventStream();
      });
    } catch (error) {
      console.error('Failed to start Docker event stream:', error);
    }
  }

  private reconnectEventStream(): void {
    // A dropped stream can emit both 'error' and 'end'; schedule one reconnect for both.
    if (this.reconnectTimer) return;
    if (this.eventStream) {
      (this.eventStream as Readable).destroy();
      this.eventStream = null;
    }
    
    // Clear the buffer when reconnecting
    this.eventBuffer = '';

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isConnected) {
        // startEventStream catches and logs its own failures.
        void this.startEventStream();
      }
    }, 5000);
  }

  private handleDockerEvent(event: { Type?: string; Action?: string }) {
    if (!isComposeRelevantEvent(event) || this.eventRefreshTimer) return;
    this.eventRefreshTimer = setTimeout(() => {
      this.eventRefreshTimer = null;
      // refreshComposeConfigs catches and logs its own failures.
      void this.refreshComposeConfigs();
    }, EVENT_REFRESH_DELAY_MS);
  }

  private startPeriodicRefresh() {
    // Refresh compose configs every 30 seconds
    this.refreshInterval = setInterval(() => {
      // refreshComposeConfigs catches and logs its own failures.
      if (this.isConnected) void this.refreshComposeConfigs();
    }, 30000);
  }

  /**
   * Re-read compose projects into the cache. Readers pass `emit: false`: subscribers answer
   * `compose-configs-updated` by reading, so a read that emits would start the next read.
   */
  private async refreshComposeConfigs({ emit = true }: { emit?: boolean } = {}) {
    if (!this.docker || !this.isConnected) return;

    try {
      const containers = await this.docker.listContainers({ all: true });
      const composeConfigs = new Map<string, DockerComposeConfig>();
      const filesExist = await this.composeFilesExistByPath(containers);

      // Group containers by compose project
      for (const container of containers) {
        const projectName = container.Labels['com.docker.compose.project'];
        const serviceName = container.Labels['com.docker.compose.service'];
        const composePath = container.Labels['com.docker.compose.project.working_dir'];

        if (projectName && serviceName && composePath) {
          // Only add compose configs if the compose files still exist
          if (filesExist.get(composePath)) {
            if (!composeConfigs.has(composePath)) {
              composeConfigs.set(composePath, {
                id: this.generateConfigId(composePath),
                name: projectName,
                status: 'stopped',
                services: [],
                path: composePath,
                lastUpdated: new Date().toISOString()
              });
            }
          } else {
            // Skip this compose path as it no longer has compose files
            // (Silently skip - no need to log every directory without compose files)
            continue;
          }

          const config = composeConfigs.get(composePath)!;
          const serviceInfo: DockerServiceInfo = {
            name: serviceName,
            status: this.mapContainerStatus(container.State),
            image: container.Image,
            ports: this.extractPorts(container.Ports),
            health: this.getContainerHealth(container)
          };

          // Check if this service already exists and replace it if this container is more recent/healthy
          const existingServiceIndex = config.services.findIndex(s => s.name === serviceName);
          if (existingServiceIndex >= 0) {
            // Replace existing service with the new one (prioritize running containers)
            const existingService = config.services[existingServiceIndex];
            if (serviceInfo.status === 'running' && existingService.status !== 'running') {
              config.services[existingServiceIndex] = serviceInfo;
            } else if (serviceInfo.status === existingService.status) {
              // If same status, prefer the one with better health
              if (serviceInfo.health === 'healthy' && existingService.health !== 'healthy') {
                config.services[existingServiceIndex] = serviceInfo;
              }
            }
          } else {
            // Add new service
            config.services.push(serviceInfo);
          }
        }
      }

      // Determine overall status for each compose config
      for (const config of composeConfigs.values()) {
        config.status = this.determineComposeStatus(config.services);
      }

      // Update cache and emit changes
      const configsArray = Array.from(composeConfigs.values());
      this.configCache.clear();
      configsArray.forEach(config => this.configCache.set(config.id, config));

      if (emit) {
        this.emit('compose-configs-updated', configsArray);
      }
    } catch (error) {
      console.error('Error refreshing compose configs:', error);
    }
  }

  /**
   * Whether the project's compose files are still on disk. Uses the files the engine
   * recorded (`-f` included), else Compose's default file names in the working dir.
   */
  private async composeFilesExist(workingDir: string, labels: Record<string, string>): Promise<boolean> {
    const configFiles = labels['com.docker.compose.project.config_files'];
    const candidates = configFiles
      ? configFiles.split(',').map((file) => path.resolve(workingDir, file.trim()))
      : COMPOSE_FILE_NAMES.map((name) => path.join(workingDir, name));
    // Async, so the check runs on libuv's threads: projects often sit under ~/Documents, and a
    // blocking call there can stall the main thread on a macOS permission check.
    const found = await Promise.all(
      candidates.map((file) => fs.promises.access(file).then(() => true, () => false))
    );
    return found.includes(true);
  }

  /** One check per compose working directory, however many of its containers are listed. */
  private async composeFilesExistByPath(
    containers: { Labels: Record<string, string> }[]
  ): Promise<Map<string, boolean>> {
    const labelsByPath = new Map<string, Record<string, string>>();
    for (const container of containers) {
      const composePath = container.Labels['com.docker.compose.project.working_dir'];
      if (composePath && !labelsByPath.has(composePath)) labelsByPath.set(composePath, container.Labels);
    }
    const entries = await Promise.all(
      [...labelsByPath].map(async ([composePath, labels]) => [composePath, await this.composeFilesExist(composePath, labels)] as const)
    );
    return new Map(entries);
  }

  private generateConfigId(path: string): string {
    return Buffer.from(path).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  }

  private mapContainerStatus(dockerState: string): DockerServiceInfo['status'] {
    switch (dockerState) {
      case 'running':
        return 'running';
      case 'exited':
        return 'stopped';
      case 'created':
        return 'stopped';
      case 'restarting':
        return 'starting';
      default:
        return 'error';
    }
  }

  private extractPorts(ports: Docker.Port[]): string[] {
    if (!ports) return [];
    return ports.map(port => {
      if (port.PublicPort && port.PrivatePort) {
        return `${port.PublicPort}:${port.PrivatePort}`;
      }
      return `${port.PrivatePort}`;
    });
  }

  private getContainerHealth(container: Docker.ContainerInfo): DockerServiceInfo['health'] {
    const health = container.Status;
    // 'unhealthy' contains 'healthy', so it has to be checked first.
    if (health?.includes('unhealthy')) return 'unhealthy';
    if (health?.includes('healthy')) return 'healthy';
    if (health?.includes('starting')) return 'starting';
    return 'unknown';
  }

  private determineComposeStatus(services: DockerServiceInfo[]): DockerComposeConfig['status'] {
    if (services.length === 0) return 'stopped';
    
    const runningServices = services.filter(s => s.status === 'running');
    const errorServices = services.filter(s => s.status === 'error');
    const startingServices = services.filter(s => s.status === 'starting');

    if (errorServices.length > 0) return 'error';
    if (startingServices.length > 0) return 'starting';
    if (runningServices.length === services.length) return 'running';
    if (runningServices.length === 0) return 'stopped';
    
    return 'stopped';
  }

  // Public API methods
  async isDockerRunning(): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async getComposeConfigs(): Promise<DockerComposeConfig[]> {
    await this.ensureReady();
    if (!this.isConnected) {
      return [];
    }
    
    await this.refreshComposeConfigs({ emit: false });
    return Array.from(this.configCache.values());
  }

  // Cleanup method
  destroy() {
    if (this.eventStream) {
      (this.eventStream as Readable).destroy();
      this.eventStream = null;
    }
    
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventRefreshTimer) {
      clearTimeout(this.eventRefreshTimer);
      this.eventRefreshTimer = null;
    }
    this.isConnected = false;
    
    // Clear the event buffer
    this.eventBuffer = '';
    
    this.removeAllListeners();
  }
}

export const dockerService = new DockerService(); 