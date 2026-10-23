import type {
  ComposeInventoryProject,
  ComposeInventorySnapshot,
  ComposeProjectStatus,
} from '../../../shared/types/composeInventory';
import {
  dockerService,
  type DockerComposeConfig,
  type DockerServiceInfo,
} from '../dockerService';

function asStatus(value: DockerComposeConfig['status'] | DockerServiceInfo['status']): ComposeProjectStatus {
  return value;
}

export function mapComposeInventory(configs: DockerComposeConfig[]): ComposeInventoryProject[] {
  return configs.map((config) => ({
    id: config.id,
    name: config.name,
    status: asStatus(config.status),
    path: config.path,
    services: config.services.map((service) => ({
      name: service.name,
      status: asStatus(service.status),
      ports: [...service.ports],
    })),
  }));
}

export async function readComposeInventory(): Promise<ComposeInventorySnapshot> {
  const engineRunning = await dockerService.isDockerRunning().catch(() => false);
  if (!engineRunning) {
    return { engineRunning: false, projects: [] };
  }
  const configs = await dockerService.getComposeConfigs().catch((): DockerComposeConfig[] => []);
  return {
    engineRunning: true,
    projects: mapComposeInventory(configs),
  };
}
