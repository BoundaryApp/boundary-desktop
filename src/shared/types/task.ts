export type TaskStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';

// Task type definitions
export type TaskType =
  | 'generic'
  | 'app-install'
  | 'app-update'
  | 'app-delete'
  | 'backup'
  | 'sync'
  | 'build'
  | 'deploy'
  | 'account-creation'
  | 'terraform-apply'
  | 'terraform-destroy'
  | 'inference-deploy'
  | 'inference-destroy';

// Base interface for all task types
export interface BaseTask {
  id: string;
  name: string;
  description?: string;
  status: TaskStatus;
  progress: number; // 0-100
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  canceledAt?: Date;
  error?: string;
  metadata?: Record<string, any>;
  filePath?: string; // Path to task-related files
  currentStage?: string; // Current stage/step of the task
  parentTaskId?: string; // Reference to parent task
  childTaskIds?: string[]; // Array of child task IDs for quick access
  taskType: TaskType; // Type of task
}

// Generic task (current implementation)
export interface Task extends BaseTask {
  taskType: 'generic';
}

// App installation task
export interface AppInstallTask extends BaseTask {
  taskType: 'app-install';
  appId: string;
  appName: string;
  appVersion: string;
  downloadUrl: string;
  repository?: string; // Local path or download URL for registry access
  repositoryUrl?: string; // Original Git repository URL from manifest
  localPath?: string; // Local directory path for local apps
  author: string;
  category: string;
  securityAnalysis?: SecurityAnalysis;
  permissionGrant?: PermissionGrant;
  installResult?: InstallResult;
}

// App update task
export interface AppUpdateTask extends BaseTask {
  taskType: 'app-update';
  appId: string;
  currentVersion: string;
  targetVersion: string;
  updateUrl: string;
  backupPath?: string;
}

// App deletion task
export interface AppDeleteTask extends BaseTask {
  taskType: 'app-delete';
  appId: string;
  appName: string;
  deletionMethod: 'complete-cleanup';
}

// Backup task
export interface BackupTask extends BaseTask {
  taskType: 'backup';
  sourcePath: string;
  destinationPath: string;
  backupType: 'full' | 'incremental' | 'differential';
  compressionLevel: number;
}

// Sync task
export interface SyncTask extends BaseTask {
  taskType: 'sync';
  sourcePath: string;
  destinationPath: string;
  syncMode: 'one-way' | 'two-way' | 'mirror';
  conflictResolution: 'source-wins' | 'destination-wins' | 'manual';
}

// Build task
export interface BuildTask extends BaseTask {
  taskType: 'build';
  projectPath: string;
  buildTarget: string;
  buildConfiguration: 'debug' | 'release';
  buildTools: string[];
}

// Deploy task
export interface DeployTask extends BaseTask {
  taskType: 'deploy';
  deploymentTarget: string;
  deploymentMethod: 'ssh' | 'docker' | 'kubernetes' | 'cloud';
  environment: 'development' | 'staging' | 'production';
  rollbackEnabled: boolean;
}

// Account creation task
export interface AccountCreationTask extends BaseTask {
  taskType: 'account-creation';
  providers: string[];
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
  phone?: string;
  results?: Array<{
    provider: string;
    success: boolean;
    accountId?: string;
    apiKey?: string;
    error?: string;
  }>;
}

export interface TerraformStackTaskFields {
  stackInstanceId: string;
  stackTypeId: string;
  workspacePath: string;
}

// Terraform apply task
export interface TerraformApplyTask extends BaseTask, TerraformStackTaskFields {
  taskType: 'terraform-apply';
}

// Terraform destroy task
export interface TerraformDestroyTask extends BaseTask, TerraformStackTaskFields {
  taskType: 'terraform-destroy';
}

export interface InferenceDeployTask extends BaseTask {
  taskType: 'inference-deploy';
  stackInstanceId: string;
  stackTypeId: string;
  workspacePath?: string;
}

export interface InferenceDestroyTask extends BaseTask {
  taskType: 'inference-destroy';
  stackInstanceId: string;
  stackTypeId: string;
  workspacePath?: string;
}

// Union type for all task types
export type AnyTask =
  | Task
  | AppInstallTask
  | AppUpdateTask
  | AppDeleteTask
  | BackupTask
  | SyncTask
  | BuildTask
  | DeployTask
  | AccountCreationTask
  | TerraformApplyTask
  | TerraformDestroyTask
  | InferenceDeployTask
  | InferenceDestroyTask;

// Type-safe task creation - maps TaskType to the corresponding interface
export type TaskTypeToInterface = {
  'generic': Task;
  'app-install': AppInstallTask;
  'app-update': AppUpdateTask;
  'app-delete': AppDeleteTask;
  'backup': BackupTask;
  'sync': SyncTask;
  'build': BuildTask;
  'deploy': DeployTask;
  'account-creation': AccountCreationTask;
  'terraform-apply': TerraformApplyTask;
  'terraform-destroy': TerraformDestroyTask;
  'inference-deploy': InferenceDeployTask;
  'inference-destroy': InferenceDestroyTask;
};

// Type-safe request parameters for each task type
export type TaskTypeToRequest = {
  'generic': {
    name: string;
    description?: string;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'app-install': {
    name: string;
    description?: string;
    appId: string;
    appName: string;
    appVersion: string;
    downloadUrl: string;
    repositoryUrl?: string;
    author: string;
    category: string;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'app-update': {
    name: string;
    description?: string;
    appId: string;
    currentVersion: string;
    targetVersion: string;
    updateUrl: string;
    backupPath?: string;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'app-delete': {
    name: string;
    description?: string;
    appId: string;
    appName: string;
    deletionMethod: 'complete-cleanup';
    metadata?: Record<string, any>;
    filePath?: string;
    parentTaskId?: string;
  };
  'backup': {
    name: string;
    description?: string;
    sourcePath: string;
    destinationPath: string;
    backupType: 'full' | 'incremental' | 'differential';
    compressionLevel?: number;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'sync': {
    name: string;
    description?: string;
    sourcePath: string;
    destinationPath: string;
    syncMode: 'one-way' | 'two-way' | 'mirror';
    conflictResolution?: 'source-wins' | 'destination-wins' | 'manual';
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'build': {
    name: string;
    description?: string;
    projectPath: string;
    buildTarget: string;
    buildConfiguration?: 'debug' | 'release';
    buildTools?: string[];
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'deploy': {
    name: string;
    description?: string;
    deploymentTarget: string;
    deploymentMethod: 'ssh' | 'docker' | 'kubernetes' | 'cloud';
    environment?: 'development' | 'staging' | 'production';
    rollbackEnabled?: boolean;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'account-creation': {
    name: string;
    description?: string;
    providers: string[];
    email: string;
    firstName: string;
    lastName: string;
    company?: string;
    phone?: string;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'terraform-apply': {
    name: string;
    description?: string;
    stackInstanceId: string;
    stackTypeId: string;
    workspacePath: string;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'terraform-destroy': {
    name: string;
    description?: string;
    stackInstanceId: string;
    stackTypeId: string;
    workspacePath: string;
    metadata?: Record<string, any>;
    filePath?: string;
  };
  'inference-deploy': {
    name: string;
    description?: string;
    metadata?: Record<string, any>;
    filePath?: string;
    taskType: 'inference-deploy';
  };
  'inference-destroy': {
    name: string;
    description?: string;
    metadata?: Record<string, any>;
    filePath?: string;
    taskType: 'inference-destroy';
  };
};

// Task type metadata for registration
export interface TaskTypeMetadata {
  type: TaskType;
  displayName: string;
  description: string;
  icon: string;
  color: string;
  defaultStages: string[];
  canHaveChildren: boolean;
  maxChildren?: number;
}

// Child task summary for storing in parent's metadata
export interface ChildTaskSummary {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  currentStage?: string;
  error?: string;
  updatedAt: Date;
  taskType: TaskType;
}

// Import types that might be used by task types
export interface SecurityAnalysis {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  vulnerabilities: string[];
  permissions: string[];
  analysisDate: Date;
}

export interface PermissionGrant {
  permissions: string[];
  granted: boolean;
  grantedAt?: Date;
  grantedBy?: string;
}

export interface InstallResult {
  success: boolean;
  installPath: string;
  executablePath: string;
  dependencies: string[];
  installedAt: Date;
}

export interface CreateTaskRequest {
  id?: string;
  name: string;
  description?: string;
  metadata?: Record<string, any>;
  filePath?: string;
  currentStage?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  taskType: TaskType;
  // Type-specific fields
  appId?: string;
  appName?: string;
  appVersion?: string;
  deletionMethod?: string;
  downloadUrl?: string;
  author?: string;
  category?: string;
  categories?: string[];
  currentVersion?: string;
  targetVersion?: string;
  updateUrl?: string;
  sourcePath?: string;
  destinationPath?: string;
  backupType?: 'full' | 'incremental' | 'differential';
  compressionLevel?: number;
  syncMode?: 'one-way' | 'two-way' | 'mirror';
  conflictResolution?: 'source-wins' | 'destination-wins' | 'manual';
  projectPath?: string;
  buildTarget?: string;
  buildConfiguration?: 'debug' | 'release';
  buildTools?: string[];
  deploymentTarget?: string;
  deploymentMethod?: 'ssh' | 'docker' | 'kubernetes' | 'cloud';
  environment?: 'development' | 'staging' | 'production';
  rollbackEnabled?: boolean;
  // Account creation fields
  providers?: string[];
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
  stackInstanceId?: string;
  stackTypeId?: string;
  workspacePath?: string;
}

export interface UpdateTaskRequest {
  id: string;
  name?: string;
  description?: string;
  status?: TaskStatus;
  progress?: number;
  error?: string;
  metadata?: Record<string, any>;
  filePath?: string;
  currentStage?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  // Type-specific fields (same as CreateTaskRequest)
  appId?: string;
  appName?: string;
  appVersion?: string;
  deletionMethod?: string;
  downloadUrl?: string;
  author?: string;
  category?: string;
  currentVersion?: string;
  targetVersion?: string;
  updateUrl?: string;
  sourcePath?: string;
  destinationPath?: string;
  backupType?: 'full' | 'incremental' | 'differential';
  compressionLevel?: number;
  syncMode?: 'one-way' | 'two-way' | 'mirror';
  conflictResolution?: 'source-wins' | 'destination-wins' | 'manual';
  projectPath?: string;
  buildTarget?: string;
  buildConfiguration?: 'debug' | 'release';
  buildTools?: string[];
  deploymentTarget?: string;
  deploymentMethod?: 'ssh' | 'docker' | 'kubernetes' | 'cloud';
  environment?: 'development' | 'staging' | 'production';
  rollbackEnabled?: boolean;
}

export interface TaskFileOperation {
  taskId: string;
  operation: 'create' | 'read' | 'update' | 'delete';
  path?: string;
  content?: string | Buffer;
}

export interface TaskFileResult {
  success: boolean;
  data?: string | Buffer;
  error?: string;
} 