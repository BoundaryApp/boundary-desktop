import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { TaskStatus, TaskType } from '../../../shared/types/task';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', { enum: ['idle', 'running', 'paused', 'completed', 'failed', 'canceled'] }).notNull().$type<TaskStatus>(),
  progress: real('progress').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  canceledAt: integer('canceled_at', { mode: 'timestamp' }),
  error: text('error'),
  metadata: text('metadata'), // JSON string
  filePath: text('file_path'),
  currentStage: text('current_stage'),
  parentTaskId: text('parent_task_id'), // Reference to parent task
  childTaskIds: text('child_task_ids'), // JSON array of child task IDs for quick access
  taskType: text('task_type', {
    enum: [
      'generic',
      'app-install',
      'app-update',
      'app-delete',
      'backup',
      'sync',
      'build',
      'deploy',
      'account-creation',
      'terraform-apply',
      'terraform-destroy',
      'inference-deploy',
      'inference-destroy',
    ],
  })
    .notNull()
    .default('generic')
    .$type<TaskType>(),
  // Type-specific fields (stored as JSON in metadata, but also as separate columns for querying)
  appId: text('app_id'),
  appName: text('app_name'),
  appVersion: text('app_version'),
  deletionMethod: text('deletion_method'),
  downloadUrl: text('download_url'),
  author: text('author'),
  category: text('category'),
  currentVersion: text('current_version'),
  targetVersion: text('target_version'),
  updateUrl: text('update_url'),
  sourcePath: text('source_path'),
  destinationPath: text('destination_path'),
  backupType: text('backup_type'),
  compressionLevel: integer('compression_level'),
  syncMode: text('sync_mode'),
  conflictResolution: text('conflict_resolution'),
  projectPath: text('project_path'),
  buildTarget: text('build_target'),
  buildConfiguration: text('build_configuration'),
  buildTools: text('build_tools'), // JSON array
  deploymentTarget: text('deployment_target'),
  deploymentMethod: text('deployment_method'),
  environment: text('environment'),
  rollbackEnabled: integer('rollback_enabled', { mode: 'boolean' }),
  // Account creation fields
  providers: text('providers'), // JSON array
  email: text('email'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  company: text('company'),
  phone: text('phone'),
});

export type TaskRecord = typeof tasks.$inferSelect;
export type NewTaskRecord = typeof tasks.$inferInsert; 