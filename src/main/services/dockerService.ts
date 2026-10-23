import Docker from 'dockerode';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { urlDetectionService, DetectedURL } from './urlDetectionService';
import {
  dockerodeOptionsFromApiEndpoint,
  getContainerRuntime,
  runCompose,
} from './containerRuntime';

export interface DockerComposeConfig {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting' | 'stopping';
  services: DockerServiceInfo[];
  path: string;
  lastUpdated: string;
  urls?: DetectedURL[];
}

export interface DockerServiceInfo {
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting' | 'stopping';
  image: string;
  ports: string[];
  health: 'healthy' | 'unhealthy' | 'starting' | 'unknown';
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string[];
  health: string;
  labels: Record<string, string>;
}

class DockerService extends EventEmitter {
  private docker: Docker | null = null;
  private isConnected = false;
  private eventStream: NodeJS.ReadableStream | null = null;
  private knownComposePaths: string[] = [];
  private configCache: Map<string, DockerComposeConfig> = new Map();
  private refreshInterval: NodeJS.Timeout | null = null;
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

        this.startEventStream();
        this.startPeriodicRefresh();

        await this.discoverComposeFilesInternal();

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

      this.eventStream.on('data', async (chunk) => {
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

  private async reconnectEventStream() {
    if (this.eventStream) {
      (this.eventStream as any).destroy();
      this.eventStream = null;
    }
    
    // Clear the buffer when reconnecting
    this.eventBuffer = '';

    setTimeout(() => {
      if (this.isConnected) {
        this.startEventStream();
      }
    }, 5000);
  }

  private async handleDockerEvent(event: any) {
    // Emit the raw event for debugging
    this.emit('docker-event', event);

    // Handle container events that might affect compose configs
    if (event.Type === 'container') {
      await this.refreshComposeConfigs();
    }
  }

  private startPeriodicRefresh() {
    // Refresh compose configs every 30 seconds
    this.refreshInterval = setInterval(async () => {
      if (this.isConnected) {
        await this.refreshComposeConfigs();
      }
    }, 30000);
  }

  private async discoverComposeFilesInternal() {
    try {
      // Common paths to search for docker-compose files
      const searchPaths = [
        process.env.HOME + '/Documents',
        process.env.HOME + '/Projects',
        process.env.HOME + '/workspace',
        process.env.HOME + '/Desktop',
        '/Users',
        '/home',
      ].filter(Boolean) as string[];

      const composeFiles: string[] = [];
      const maxResults = 20;

      for (const searchPath of searchPaths) {
        if (composeFiles.length >= maxResults) break;
        if (!fs.existsSync(searchPath)) continue;
        try {
          await this.walkForComposeFiles(searchPath, composeFiles, maxResults, 0, 4);
        } catch {
          // Ignore errors for individual search paths
        }
      }

      this.knownComposePaths = [...new Set(composeFiles)];
      console.log(`Discovered ${this.knownComposePaths.length} Docker Compose files`);
    } catch (error) {
      console.error('Error discovering compose files:', error);
    }
  }

  private async walkForComposeFiles(
    dir: string,
    out: string[],
    maxResults: number,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (out.length >= maxResults || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxResults) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name === 'docker-compose.yml' || entry.name === 'docker-compose.yaml') {
          out.push(fullPath);
        }
      } else if (entry.isDirectory()) {
        await this.walkForComposeFiles(fullPath, out, maxResults, depth + 1, maxDepth);
      }
    }
  }

  private async refreshComposeConfigs() {
    if (!this.docker || !this.isConnected) return;

    try {
      const containers = await this.docker.listContainers({ all: true });
      const composeConfigs = new Map<string, DockerComposeConfig>();

      // Group containers by compose project
      for (const container of containers) {
        const projectName = container.Labels['com.docker.compose.project'];
        const serviceName = container.Labels['com.docker.compose.service'];
        const composePath = container.Labels['com.docker.compose.project.working_dir'];

        if (projectName && serviceName && composePath) {
          // Only add compose configs if the compose files still exist
          const composeFile = path.join(composePath, 'docker-compose.yml');
          const composeFileYaml = path.join(composePath, 'docker-compose.yaml');
          
          if (fs.existsSync(composeFile) || fs.existsSync(composeFileYaml)) {
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

      this.emit('compose-configs-updated', configsArray);
    } catch (error) {
      console.error('Error refreshing compose configs:', error);
    }
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

  private extractPorts(ports: any[]): string[] {
    if (!ports) return [];
    return ports.map(port => {
      if (port.PublicPort && port.PrivatePort) {
        return `${port.PublicPort}:${port.PrivatePort}`;
      }
      return `${port.PrivatePort}`;
    });
  }

  private getContainerHealth(container: any): DockerServiceInfo['health'] {
    const health = container.Status;
    if (health?.includes('healthy')) return 'healthy';
    if (health?.includes('unhealthy')) return 'unhealthy';
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
    } catch (error) {
      return false;
    }
  }

  async getComposeConfigs(): Promise<DockerComposeConfig[]> {
    await this.ensureReady();
    if (!this.isConnected) {
      return [];
    }
    
    await this.refreshComposeConfigs();
    const configs = Array.from(this.configCache.values());
    
    // Enhance with URL detection - only for configs that have compose files
    for (const config of configs) {
      try {
        // Check if compose file exists before attempting URL detection
        const composeFile = path.join(config.path, 'docker-compose.yml');
        const composeFileYaml = path.join(config.path, 'docker-compose.yaml');
        
        if (fs.existsSync(composeFile) || fs.existsSync(composeFileYaml)) {
          config.urls = await urlDetectionService.getAllURLs(config.path);
        } else {
          // No compose file found, skip URL detection silently
          config.urls = [];
        }
      } catch (error) {
        // Only log as warning if it's not a "file not found" error
        if (!error.message.includes('No docker-compose.yml or docker-compose.yaml found')) {
          console.warn(`Could not detect URLs for ${config.path}:`, error);
        }
        config.urls = [];
      }
    }
    
    return configs;
  }

  async startComposeConfig(composePath: string, dockerComposeFile?: string): Promise<void> {
    try {
      const runtime = await getContainerRuntime();
      const composeArgs = dockerComposeFile
        ? ['-f', dockerComposeFile, 'up', '-d']
        : ['up', '-d'];
      
      console.log(
        `🐳 Starting Docker Compose: ${runtime.cliPath} ${[...runtime.composeArgv, ...composeArgs].join(' ')} in ${composePath}`
      );
      
      const { stderr } = await runCompose(runtime, composeArgs, { cwd: composePath });
      if (stderr) {
        console.warn('Docker Compose start stderr:', stderr);
      }
      
      // Wait a moment for containers to start, then refresh
      setTimeout(() => this.refreshComposeConfigs(), 2000);
    } catch (error) {
      console.error('Error starting Docker Compose:', error);
      throw error;
    }
  }

  async stopComposeConfig(composePath: string): Promise<void> {
    try {
      const runtime = await getContainerRuntime();
      const { stderr } = await runCompose(runtime, ['down'], { cwd: composePath });
      if (stderr) {
        console.warn('Docker Compose stop stderr:', stderr);
      }
      
      // Wait a moment for containers to stop, then refresh
      setTimeout(() => this.refreshComposeConfigs(), 2000);
    } catch (error) {
      console.error('Error stopping Docker Compose:', error);
      throw error;
    }
  }

  async restartComposeConfig(composePath: string): Promise<void> {
    try {
      const runtime = await getContainerRuntime();
      const { stderr } = await runCompose(runtime, ['restart'], { cwd: composePath });
      if (stderr) {
        console.warn('Docker Compose restart stderr:', stderr);
      }
      
      // Wait a moment for containers to restart, then refresh
      setTimeout(() => this.refreshComposeConfigs(), 2000);
    } catch (error) {
      console.error('Error restarting Docker Compose:', error);
      throw error;
    }
  }

  async getComposeStatus(composePath: string): Promise<any> {
    try {
      const runtime = await getContainerRuntime();
      const { stdout } = await runCompose(runtime, ['ps', '--format', 'json'], {
        cwd: composePath,
      });
      return JSON.parse(stdout);
    } catch (error) {
      console.error('Error getting Docker Compose status:', error);
      throw error;
    }
  }

  async getServiceLogs(composePath: string, serviceName: string, lines: number = 100): Promise<string> {
    try {
      const runtime = await getContainerRuntime();
      const { stdout } = await runCompose(
        runtime,
        ['logs', `--tail=${lines}`, serviceName],
        { cwd: composePath }
      );
      return stdout;
    } catch (error) {
      console.error('Error getting service logs:', error);
      throw error;
    }
  }

  async discoverComposeFiles(): Promise<string[]> {
    await this.discoverComposeFilesInternal();
    return this.knownComposePaths;
  }

  async getContainerInfo(containerId: string): Promise<DockerContainerInfo | null> {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const container = client.getContainer(containerId);
      const info = await container.inspect();
      
      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ''),
        image: info.Config.Image,
        status: info.State.Status,
        ports: this.extractPortsFromInspect(info),
        health: info.State.Health?.Status || 'unknown',
        labels: info.Config.Labels || {}
      };
    } catch (error) {
      console.error('Error getting container info:', error);
      return null;
    }
  }

  /**
   * Get detected URLs for a specific compose setup
   */
  async getComposeURLs(composePath: string): Promise<DetectedURL[]> {
    try {
      return await urlDetectionService.getAllURLs(composePath);
    } catch (error) {
      console.error('Error getting compose URLs:', error);
      return [];
    }
  }

  /**
   * Get detected URLs for a specific service within a compose setup
   */
  async getServiceURLs(composePath: string, serviceName: string): Promise<DetectedURL[]> {
    try {
      return await urlDetectionService.getServiceURLs(composePath, serviceName);
    } catch (error) {
      console.error('Error getting service URLs:', error);
      return [];
    }
  }

  private extractPortsFromInspect(info: any): string[] {
    const ports: string[] = [];
    const portBindings = info.HostConfig.PortBindings;
    
    if (portBindings) {
      Object.keys(portBindings).forEach(containerPort => {
        const hostBindings = portBindings[containerPort];
        hostBindings.forEach((binding: any) => {
          ports.push(`${binding.HostPort}:${containerPort}`);
        });
      });
    }
    
    return ports;
  }

  // Cleanup method
  destroy() {
    if (this.eventStream) {
      (this.eventStream as any).destroy();
      this.eventStream = null;
    }
    
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    
    // Clear the event buffer
    this.eventBuffer = '';
    
    this.removeAllListeners();
  }
}

export const dockerService = new DockerService(); 