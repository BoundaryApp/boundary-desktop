import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import Docker from 'dockerode';
import {
  dockerodeOptionsFromApiEndpoint,
  getContainerRuntime,
} from './containerRuntime';

export interface DetectedURL {
  url: string;
  service: string;
  port: number;
  protocol: 'http' | 'https' | 'ws' | 'wss';
  host: string;
  path?: string;
  isHealthy: boolean;
  source: 'compose-file' | 'running-container' | 'env-variable' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
}

export interface ComposeServiceAnalysis {
  serviceName: string;
  ports: Array<{
    internal: number;
    external: number;
    protocol: string;
  }>;
  environment: Record<string, string>;
  labels: Record<string, string>;
  healthcheck?: any;
  urls: DetectedURL[];
}

export interface ComposeAnalysis {
  composePath: string;
  projectName: string;
  services: ComposeServiceAnalysis[];
  allUrls: DetectedURL[];
  envFiles: string[];
  envVariables: Record<string, string>;
}

class URLDetectionService {
  private docker: Docker | null = null;
  private initPromise: Promise<Docker | null> | null = null;

  constructor() {
    // Deliberately do not open a Docker socket at import/construct time.
  }

  async ensureReady(): Promise<Docker | null> {
    if (this.docker) {
      return this.docker;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const runtime = await getContainerRuntime();
        const client = new Docker(dockerodeOptionsFromApiEndpoint(runtime.apiEndpoint));
        await client.ping();
        this.docker = client;
        return client;
      } catch (error) {
        console.warn('Docker not available for URL detection:', error);
        this.docker = null;
        return null;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Analyze a Docker Compose setup and detect all available URLs
   */
  async analyzeComposeSetup(composePath: string): Promise<ComposeAnalysis> {
    const analysis: ComposeAnalysis = {
      composePath,
      projectName: path.basename(composePath),
      services: [],
      allUrls: [],
      envFiles: [],
      envVariables: {}
    };

    try {
      // 1. Parse compose file
      const composeData = await this.parseComposeFile(composePath);
      
      // 2. Load environment files
      analysis.envFiles = await this.findEnvFiles(composePath);
      analysis.envVariables = await this.loadEnvironmentVariables(composePath, analysis.envFiles);

      // 3. Analyze each service
      for (const [serviceName, serviceConfig] of Object.entries(composeData.services || {})) {
        const serviceAnalysis = await this.analyzeService(
          serviceName, 
          serviceConfig, 
          analysis.envVariables,
          composePath
        );
        analysis.services.push(serviceAnalysis);
        analysis.allUrls.push(...serviceAnalysis.urls);
      }

      // 4. Get running container information if available
      const client = await this.ensureReady();
      if (client) {
        await this.enhanceWithRunningContainers(analysis);
      }

      // 5. Remove duplicates and invalid URLs
      analysis.allUrls = this.deduplicateAndValidateUrls(analysis.allUrls);

      // 6. Validate URLs
      await this.validateUrls(analysis.allUrls);

      return analysis;
    } catch (error) {
      // Only log as error if it's not a missing compose file (which is expected for some directories)
      if (!error.message.includes('No docker-compose.yml or docker-compose.yaml found')) {
        console.error('Error analyzing compose setup:', error);
      }
      throw error;
    }
  }

  /**
   * Parse Docker Compose file (supports both YAML and JSON formats)
   */
  private async parseComposeFile(composePath: string): Promise<any> {
    const composeFile = path.join(composePath, 'docker-compose.yml');
    const composeFileYaml = path.join(composePath, 'docker-compose.yaml');
    
    let filePath: string;
    if (fs.existsSync(composeFile)) {
      filePath = composeFile;
    } else if (fs.existsSync(composeFileYaml)) {
      filePath = composeFileYaml;
    } else {
      throw new Error('No docker-compose.yml or docker-compose.yaml found');
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content);
  }

  /**
   * Find all environment files in the compose directory
   */
  private async findEnvFiles(composePath: string): Promise<string[]> {
    const envFiles: string[] = [];
    const files = fs.readdirSync(composePath);
    
    for (const file of files) {
      if (file.startsWith('.env') || file.endsWith('.env')) {
        envFiles.push(path.join(composePath, file));
      }
    }
    
    return envFiles;
  }

  /**
   * Load environment variables from all env files
   */
  private async loadEnvironmentVariables(composePath: string, envFiles: string[]): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};
    
    for (const envFile of envFiles) {
      try {
        const content = fs.readFileSync(envFile, 'utf8');
        const lines = content.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key && valueParts.length > 0) {
              envVars[key.trim()] = valueParts.join('=').trim();
            }
          }
        }
      } catch (error) {
        console.warn(`Could not read env file ${envFile}:`, error);
      }
    }
    
    return envVars;
  }

  /**
   * Analyze a single service for URL detection
   */
  private async analyzeService(
    serviceName: string, 
    serviceConfig: any, 
    envVars: Record<string, string>,
    composePath: string
  ): Promise<ComposeServiceAnalysis> {
    const analysis: ComposeServiceAnalysis = {
      serviceName,
      ports: [],
      environment: {},
      labels: {},
      urls: []
    };

    // Extract ports
    if (serviceConfig.ports) {
      for (const portMapping of serviceConfig.ports) {
        const parts = portMapping.split(':');
        if (parts.length >= 2) {
          const external = parseInt(parts[0]);
          const internal = parseInt(parts[1]);
          
          // Only add valid port numbers
          if (!isNaN(external) && !isNaN(internal) && external > 0 && internal > 0) {
            analysis.ports.push({
              internal,
              external,
              protocol: 'tcp' // Default, could be enhanced to detect UDP
            });
          }
        }
      }
    }

    // Extract environment variables
    if (serviceConfig.environment) {
      for (const [key, value] of Object.entries(serviceConfig.environment)) {
        analysis.environment[key] = this.resolveEnvironmentVariable(value as string, envVars);
      }
    }

    // Extract labels
    if (serviceConfig.labels) {
      analysis.labels = serviceConfig.labels;
    }

    // Extract healthcheck
    if (serviceConfig.healthcheck) {
      analysis.healthcheck = serviceConfig.healthcheck;
    }

    // Generate URLs
    analysis.urls = await this.generateURLs(serviceName, analysis, envVars);

    return analysis;
  }

  /**
   * Generate URLs for a service based on ports, environment, and labels
   */
  private async generateURLs(
    serviceName: string, 
    serviceAnalysis: ComposeServiceAnalysis,
    envVars: Record<string, string>
  ): Promise<DetectedURL[]> {
    const urls: DetectedURL[] = [];

    for (const port of serviceAnalysis.ports) {
      // Skip invalid ports
      if (isNaN(port.external) || port.external <= 0 || port.external > 65535) {
        continue;
      }

      // Determine protocol
      const protocol = this.determineProtocol(serviceName, serviceAnalysis, port);
      
      // Determine host
      const host = this.determineHost(serviceAnalysis, envVars);
      
      // Determine path
      const path = this.determinePath(serviceName, serviceAnalysis, envVars);

      // Generate base URL
      const baseUrl = `${protocol}://${host}:${port.external}`;
      const fullUrl = path ? `${baseUrl}${path}` : baseUrl;

      urls.push({
        url: fullUrl,
        service: serviceName,
        port: port.external,
        protocol,
        host,
        path,
        isHealthy: false, // Will be validated later
        source: 'compose-file',
        confidence: 'high'
      });
    }

    // Check for environment variables that might contain URLs
    for (const [key, value] of Object.entries(serviceAnalysis.environment)) {
      if (this.looksLikeURL(value)) {
        urls.push({
          url: value,
          service: serviceName,
          port: this.extractPortFromURL(value),
          protocol: this.extractProtocolFromURL(value),
          host: this.extractHostFromURL(value),
          path: this.extractPathFromURL(value),
          isHealthy: false,
          source: 'env-variable',
          confidence: 'high'
        });
      }
    }

    return urls;
  }

  /**
   * Determine protocol based on service name, environment, and labels
   */
  private determineProtocol(serviceName: string, serviceAnalysis: ComposeServiceAnalysis, port: any): 'http' | 'https' | 'ws' | 'wss' {
    // Check for explicit protocol in environment
    const protocolEnv = serviceAnalysis.environment.PROTOCOL || 
                      serviceAnalysis.environment.N8N_PROTOCOL ||
                      serviceAnalysis.environment.HTTPS ||
                      serviceAnalysis.environment.SSL;

    if (protocolEnv === 'https' || protocolEnv === 'true') return 'https';
    if (protocolEnv === 'wss') return 'wss';
    if (protocolEnv === 'ws') return 'ws';

    // Check for common HTTPS indicators
    if (serviceAnalysis.environment.SSL === 'true' || 
        serviceAnalysis.environment.HTTPS === 'true' ||
        serviceAnalysis.labels['traefik.http.routers.*.tls'] === 'true') {
      return 'https';
    }

    // Check for WebSocket indicators
    if (serviceName.toLowerCase().includes('websocket') || 
        serviceName.toLowerCase().includes('ws') ||
        serviceAnalysis.environment.WEBSOCKET === 'true') {
      return 'ws';
    }

    // Default to HTTP
    return 'http';
  }

  /**
   * Determine host based on environment and labels
   */
  private determineHost(serviceAnalysis: ComposeServiceAnalysis, envVars: Record<string, string>): string {
    // Check for explicit host in environment
    const hostEnv = serviceAnalysis.environment.HOST || 
                   serviceAnalysis.environment.N8N_HOST ||
                   serviceAnalysis.environment.BASE_URL;

    if (hostEnv && !hostEnv.includes('://')) {
      return hostEnv;
    }

    // Check for Traefik labels
    const traefikHost = serviceAnalysis.labels['traefik.http.routers.*.rule'];
    if (traefikHost && traefikHost.includes('Host(')) {
      const match = traefikHost.match(/Host\(`([^`]+)`\)/);
      if (match) return match[1];
    }

    // Default to localhost
    return 'localhost';
  }

  /**
   * Determine path based on service configuration
   */
  private determinePath(serviceName: string, serviceAnalysis: ComposeServiceAnalysis, envVars: Record<string, string>): string | undefined {
    // Check for explicit path in environment
    const pathEnv = serviceAnalysis.environment.PATH || 
                   serviceAnalysis.environment.BASE_PATH ||
                   serviceAnalysis.environment.WEBHOOK_URL;

    if (pathEnv && pathEnv.startsWith('/')) {
      return pathEnv;
    }

    // Check for Traefik path rules
    const traefikPath = serviceAnalysis.labels['traefik.http.routers.*.rule'];
    if (traefikPath && traefikPath.includes('PathPrefix(')) {
      const match = traefikPath.match(/PathPrefix\(`([^`]+)`\)/);
      if (match) return match[1];
    }

    // Default paths for common services
    const defaultPaths: Record<string, string> = {
      'n8n': '/',
      'registry': '/',
      'api': '/api',
      'web': '/',
      'frontend': '/',
      'backend': '/api'
    };

    return defaultPaths[serviceName.toLowerCase()];
  }

  /**
   * Resolve environment variable with fallback to env files
   */
  private resolveEnvironmentVariable(value: string, envVars: Record<string, string>): string {
    if (value.startsWith('${') && value.endsWith('}')) {
      const varName = value.slice(2, -1);
      return envVars[varName] || value;
    }
    return value;
  }

  /**
   * Check if a string looks like a URL
   */
  private looksLikeURL(str: string): boolean {
    return /^https?:\/\//.test(str) || /^wss?:\/\//.test(str);
  }

  /**
   * Remove duplicates and validate URLs
   */
  private deduplicateAndValidateUrls(urls: DetectedURL[]): DetectedURL[] {
    const seen = new Set<string>();
    const validUrls: DetectedURL[] = [];

    for (const url of urls) {
      // Skip invalid URLs (NaN ports, invalid protocols, etc.)
      if (!this.isValidUrl(url)) {
        continue;
      }

      // Create a unique key for deduplication
      const key = `${url.protocol}://${url.host}:${url.port}${url.path || ''}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        validUrls.push(url);
      }
    }

    return validUrls;
  }

  /**
   * Check if a URL is valid
   */
  private isValidUrl(url: DetectedURL): boolean {
    // Check for valid port number
    if (isNaN(url.port) || url.port <= 0 || url.port > 65535) {
      return false;
    }

    // Check for valid protocol
    if (!['http', 'https', 'ws', 'wss'].includes(url.protocol)) {
      return false;
    }

    // Check for valid host
    if (!url.host || url.host.trim() === '') {
      return false;
    }

    return true;
  }

  /**
   * Extract components from URL
   */
  private extractPortFromURL(url: string): number {
    const match = url.match(/:(\d+)/);
    const port = match ? parseInt(match[1]) : 80;
    return isNaN(port) ? 80 : port;
  }

  private extractProtocolFromURL(url: string): 'http' | 'https' | 'ws' | 'wss' {
    if (url.startsWith('https://')) return 'https';
    if (url.startsWith('wss://')) return 'wss';
    if (url.startsWith('ws://')) return 'ws';
    return 'http';
  }

  private extractHostFromURL(url: string): string {
    const match = url.match(/:\/\/([^:\/]+)/);
    return match ? match[1] : 'localhost';
  }

  private extractPathFromURL(url: string): string | undefined {
    const match = url.match(/:\/\/[^\/]+(\/.*)/);
    return match ? match[1] : undefined;
  }

  /**
   * Enhance analysis with running container information
   */
  private async enhanceWithRunningContainers(analysis: ComposeAnalysis): Promise<void> {
    if (!this.docker) return;

    try {
      const containers = await this.docker.listContainers({ all: true });
      
      for (const container of containers) {
        const projectName = container.Labels['com.docker.compose.project'];
        const serviceName = container.Labels['com.docker.compose.service'];
        const workingDir = container.Labels['com.docker.compose.project.working_dir'];
        
        if (projectName && serviceName && workingDir === analysis.composePath) {
          // Find matching service in analysis
          const service = analysis.services.find(s => s.serviceName === serviceName);
          if (service) {
            // Add URLs from running container (only if not already detected from compose file)
            for (const port of container.Ports || []) {
              if (port.PublicPort && !isNaN(port.PublicPort) && port.PublicPort > 0) {
                const protocol = this.determineProtocol(serviceName, service, { external: port.PublicPort });
                const url = `${protocol}://localhost:${port.PublicPort}`;
                
                // Check if this URL already exists from compose file analysis
                const existingUrl = analysis.allUrls.find(u => u.url === url);
                if (!existingUrl) {
                  analysis.allUrls.push({
                    url,
                    service: serviceName,
                    port: port.PublicPort,
                    protocol,
                    host: 'localhost',
                    isHealthy: false,
                    source: 'running-container',
                    confidence: 'high'
                  });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Could not enhance with running containers:', error);
    }
  }

  /**
   * Validate URLs by attempting to connect to them
   */
  private async validateUrls(urls: DetectedURL[]): Promise<void> {
    const validationPromises = urls.map(async (urlInfo) => {
      try {
        // Simple HTTP check - in a real implementation, you'd use a proper HTTP client
        const response = await fetch(urlInfo.url, { 
          method: 'HEAD',
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        urlInfo.isHealthy = response.ok;
      } catch (error) {
        urlInfo.isHealthy = false;
      }
    });

    await Promise.allSettled(validationPromises);
  }

  /**
   * Get URLs for a specific service
   */
  async getServiceURLs(composePath: string, serviceName: string): Promise<DetectedURL[]> {
    const analysis = await this.analyzeComposeSetup(composePath);
    const service = analysis.services.find(s => s.serviceName === serviceName);
    return service ? service.urls : [];
  }

  /**
   * Get all URLs for a compose setup
   */
  async getAllURLs(composePath: string): Promise<DetectedURL[]> {
    const analysis = await this.analyzeComposeSetup(composePath);
    return analysis.allUrls;
  }
}

export const urlDetectionService = new URLDetectionService();
