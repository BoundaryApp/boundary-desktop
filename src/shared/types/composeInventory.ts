export const COMPOSE_PROJECT_STATUSES = [
  'running',
  'stopped',
  'error',
  'starting',
  'stopping',
] as const;

export type ComposeProjectStatus = (typeof COMPOSE_PROJECT_STATUSES)[number];

export type ComposeInventoryService = {
  name: string;
  status: ComposeProjectStatus;
  ports: string[];
};

export type ComposeInventoryProject = {
  id: string;
  name: string;
  status: ComposeProjectStatus;
  path: string;
  services: ComposeInventoryService[];
};

export type ComposeInventorySnapshot = {
  engineRunning: boolean;
  projects: ComposeInventoryProject[];
};
