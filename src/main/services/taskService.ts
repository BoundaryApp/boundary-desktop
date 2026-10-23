import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import { tasks } from '../db/schema/Task';
import { Task, CreateTaskRequest, UpdateTaskRequest, TaskStatus, AnyTask, TaskType } from '../../shared/types/task';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export class TaskService {
  private getTaskFilesDir(taskId: string): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'task-files', taskId);
  }

  private getTaskLogFilePath(taskId: string): string {
    const taskFilesDir = this.getTaskFilesDir(taskId);
    return path.join(taskFilesDir, 'task.log');
  }

  async createTask(request: CreateTaskRequest): Promise<AnyTask> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const now = new Date();
    const taskId = request.id || randomUUID();
    
    const newTask = {
      id: taskId,
      name: request.name,
      description: request.description,
      status: 'idle' as TaskStatus,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      metadata: request.metadata ? JSON.stringify(request.metadata) : null,
      filePath: request.filePath,
      currentStage: request.currentStage,
      parentTaskId: request.parentTaskId,
      childTaskIds: request.childTaskIds ? JSON.stringify(request.childTaskIds) : null,
      taskType: request.taskType || 'generic',
      // Type-specific fields
      appId: request.appId,
      appName: request.appName,
      appVersion: request.appVersion,
      deletionMethod: request.deletionMethod,
      downloadUrl: request.downloadUrl,
      author: request.author,
      category: request.category,
      currentVersion: request.currentVersion,
      targetVersion: request.targetVersion,
      updateUrl: request.updateUrl,
      sourcePath: request.sourcePath,
      destinationPath: request.destinationPath,
      backupType: request.backupType,
      compressionLevel: request.compressionLevel,
      syncMode: request.syncMode,
      conflictResolution: request.conflictResolution,
      projectPath: request.projectPath,
      buildTarget: request.buildTarget,
      buildConfiguration: request.buildConfiguration,
      buildTools: request.buildTools ? JSON.stringify(request.buildTools) : null,
      deploymentTarget: request.deploymentTarget,
      deploymentMethod: request.deploymentMethod,
      environment: request.environment,
      rollbackEnabled: request.rollbackEnabled,
      // Account creation fields
      providers: request.providers ? JSON.stringify(request.providers) : null,
      email: request.email,
      firstName: request.firstName,
      lastName: request.lastName,
      company: request.company,
      phone: request.phone,
    };

    await db.insert(tasks).values(newTask);
    
    // Create task files directory
    const taskFilesDir = this.getTaskFilesDir(taskId);
    await fs.promises.mkdir(taskFilesDir, { recursive: true });
    
    // Initialize log file with task creation message
    const logFilePath = this.getTaskLogFilePath(taskId);
    const logMessage = `[${now.toISOString()}] Task created: ${request.name} (ID: ${taskId})\n`;
    await fs.promises.writeFile(logFilePath, logMessage);

    return this.mapRecordToTask(newTask);
  }

  async getTask(id: string): Promise<AnyTask | null> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const record = await db.select().from(tasks).where(eq(tasks.id, id)).get();
    return record ? this.mapRecordToTask(record) : null;
  }

  async getAllTasks(): Promise<AnyTask[]> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const records = await db.select().from(tasks).all();
    return records.map(record => this.mapRecordToTask(record));
  }

  async updateTask(request: UpdateTaskRequest): Promise<AnyTask | null> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (request.name !== undefined) updateData.name = request.name;
    if (request.description !== undefined) updateData.description = request.description;
    if (request.status !== undefined) updateData.status = request.status;
    if (request.progress !== undefined) updateData.progress = request.progress;
    if (request.error !== undefined) updateData.error = request.error;
    if (request.metadata !== undefined) updateData.metadata = JSON.stringify(request.metadata);
    if (request.filePath !== undefined) updateData.filePath = request.filePath;
    if (request.currentStage !== undefined) updateData.currentStage = request.currentStage;
    if (request.parentTaskId !== undefined) updateData.parentTaskId = request.parentTaskId;
    if (request.childTaskIds !== undefined) updateData.childTaskIds = JSON.stringify(request.childTaskIds);
    // Type-specific fields
    if (request.appId !== undefined) updateData.appId = request.appId;
    if (request.appName !== undefined) updateData.appName = request.appName;
    if (request.appVersion !== undefined) updateData.appVersion = request.appVersion;
    if (request.deletionMethod !== undefined) updateData.deletionMethod = request.deletionMethod;
    if (request.downloadUrl !== undefined) updateData.downloadUrl = request.downloadUrl;
    if (request.author !== undefined) updateData.author = request.author;
    if (request.category !== undefined) updateData.category = request.category;
    if (request.currentVersion !== undefined) updateData.currentVersion = request.currentVersion;
    if (request.targetVersion !== undefined) updateData.targetVersion = request.targetVersion;
    if (request.updateUrl !== undefined) updateData.updateUrl = request.updateUrl;
    if (request.sourcePath !== undefined) updateData.sourcePath = request.sourcePath;
    if (request.destinationPath !== undefined) updateData.destinationPath = request.destinationPath;
    if (request.backupType !== undefined) updateData.backupType = request.backupType;
    if (request.compressionLevel !== undefined) updateData.compressionLevel = request.compressionLevel;
    if (request.syncMode !== undefined) updateData.syncMode = request.syncMode;
    if (request.conflictResolution !== undefined) updateData.conflictResolution = request.conflictResolution;
    if (request.projectPath !== undefined) updateData.projectPath = request.projectPath;
    if (request.buildTarget !== undefined) updateData.buildTarget = request.buildTarget;
    if (request.buildConfiguration !== undefined) updateData.buildConfiguration = request.buildConfiguration;
    if (request.buildTools !== undefined) updateData.buildTools = JSON.stringify(request.buildTools);
    if (request.deploymentTarget !== undefined) updateData.deploymentTarget = request.deploymentTarget;
    if (request.deploymentMethod !== undefined) updateData.deploymentMethod = request.deploymentMethod;
    if (request.environment !== undefined) updateData.environment = request.environment;
    if (request.rollbackEnabled !== undefined) updateData.rollbackEnabled = request.rollbackEnabled;

    // Set timestamp fields based on status
    if (request.status === 'running' && !updateData.startedAt) {
      updateData.startedAt = new Date();
    } else if (request.status === 'completed') {
      updateData.completedAt = new Date();
    } else if (request.status === 'canceled') {
      updateData.canceledAt = new Date();
    }

    const result = await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, request.id))
      .returning()
      .get();

    return result ? this.mapRecordToTask(result) : null;
  }

  async deleteTask(id: string): Promise<boolean> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    try {
      // Delete task files directory
      const taskFilesDir = this.getTaskFilesDir(id);
      if (await fs.promises.access(taskFilesDir).then(() => true).catch(() => false)) {
        await fs.promises.rm(taskFilesDir, { recursive: true, force: true });
      }

      // Delete from database
      const result = await db.delete(tasks).where(eq(tasks.id, id)).returning().get();
      return !!result;
    } catch (error) {
      console.error('Error deleting task:', error);
      return false;
    }
  }

  async createTaskFile(taskId: string, fileName: string, content: string | Buffer): Promise<boolean> {
    try {
      const taskFilesDir = this.getTaskFilesDir(taskId);
      const filePath = path.join(taskFilesDir, fileName);
      
      await fs.promises.writeFile(filePath, content);
      return true;
    } catch (error) {
      console.error('Error creating task file:', error);
      return false;
    }
  }

  async readTaskFile(taskId: string, fileName: string): Promise<string | null> {
    try {
      const taskFilesDir = this.getTaskFilesDir(taskId);
      const filePath = path.join(taskFilesDir, fileName);
      
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      console.error('Error reading task file:', error);
      return null;
    }
  }

  async updateTaskFile(taskId: string, fileName: string, content: string | Buffer): Promise<boolean> {
    try {
      const taskFilesDir = this.getTaskFilesDir(taskId);
      const filePath = path.join(taskFilesDir, fileName);
      
      await fs.promises.writeFile(filePath, content);
      return true;
    } catch (error) {
      console.error('Error updating task file:', error);
      return false;
    }
  }

  async deleteTaskFile(taskId: string, fileName: string): Promise<boolean> {
    try {
      const taskFilesDir = this.getTaskFilesDir(taskId);
      const filePath = path.join(taskFilesDir, fileName);
      
      await fs.promises.unlink(filePath);
      return true;
    } catch (error) {
      console.error('Error deleting task file:', error);
      return false;
    }
  }

  async logToTask(taskId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<boolean> {
    try {
      const logFilePath = this.getTaskLogFilePath(taskId);
      const taskFilesDir = this.getTaskFilesDir(taskId);
      
      // Ensure the task files directory exists
      await fs.promises.mkdir(taskFilesDir, { recursive: true });
      
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
      
      await fs.promises.appendFile(logFilePath, logEntry);
      return true;
    } catch (error) {
      console.error('Error writing to task log:', error);
      return false;
    }
  }

  async getTaskLog(taskId: string): Promise<string | null> {
    try {
      const logFilePath = this.getTaskLogFilePath(taskId);
      
      // Check if the log file exists
      try {
        await fs.promises.access(logFilePath);
      } catch {
        // Log file doesn't exist yet
        return 'No log entries found for this task.';
      }
      
      return await fs.promises.readFile(logFilePath, 'utf-8');
    } catch (error) {
      console.error('Error reading task log:', error);
      return null;
    }
  }

  // Child task management methods
  async getChildTasks(parentTaskId: string): Promise<AnyTask[]> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const records = await db.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId)).all();
    return records.map(record => this.mapRecordToTask(record));
  }

  async getParentTask(childTaskId: string): Promise<AnyTask | null> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const childTask = await this.getTask(childTaskId);
    if (!childTask || !childTask.parentTaskId) {
      return null;
    }
    
    return await this.getTask(childTask.parentTaskId);
  }

  async addChildTask(parentTaskId: string, childTaskId: string): Promise<void> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    // Get current child task IDs
    const parentTask = await this.getTask(parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task ${parentTaskId} not found`);
    }
    
    const currentChildIds = parentTask.childTaskIds || [];
    if (currentChildIds.includes(childTaskId)) {
      return; // Already a child
    }
    
    // Update parent task with new child
    await this.updateTask({
      id: parentTaskId,
      childTaskIds: [...currentChildIds, childTaskId]
    });
    
    // Update child task with parent reference
    await this.updateTask({
      id: childTaskId,
      parentTaskId: parentTaskId
    });
  }

  async removeChildTask(parentTaskId: string, childTaskId: string): Promise<void> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    // Get current child task IDs
    const parentTask = await this.getTask(parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task ${parentTaskId} not found`);
    }
    
    const currentChildIds = parentTask.childTaskIds || [];
    const updatedChildIds = currentChildIds.filter(id => id !== childTaskId);
    
    // Update parent task
    await this.updateTask({
      id: parentTaskId,
      childTaskIds: updatedChildIds
    });
    
    // Remove parent reference from child task
    await this.updateTask({
      id: childTaskId,
      parentTaskId: undefined
    });
  }

  async deleteTaskWithChildren(taskId: string): Promise<boolean> {
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    try {
      // Get child tasks
      const childTasks = await this.getChildTasks(taskId);
      
      // Delete child tasks first
      for (const childTask of childTasks) {
        await this.deleteTask(childTask.id);
      }
      
      // Delete the parent task
      return await this.deleteTask(taskId);
    } catch (error) {
      console.error('Error deleting task with children:', error);
      return false;
    }
  }

  private mapRecordToTask(record: any): AnyTask {
    const baseTask = {
      id: record.id,
      name: record.name,
      description: record.description,
      status: record.status,
      progress: record.progress,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
      completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
      canceledAt: record.canceledAt ? new Date(record.canceledAt) : undefined,
      error: record.error,
      metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
      filePath: record.filePath,
      currentStage: record.currentStage,
      parentTaskId: record.parentTaskId,
      childTaskIds: record.childTaskIds ? JSON.parse(record.childTaskIds) : undefined,
      taskType: record.taskType || 'generic',
    };

    // Return typed task based on taskType
    switch (record.taskType) {
      case 'app-install':
        return {
          ...baseTask,
          taskType: 'app-install',
          appId: record.appId,
          appName: record.appName,
          appVersion: record.appVersion,
          downloadUrl: record.downloadUrl,
          author: record.author,
          category: record.category,
          securityAnalysis: record.securityAnalysis ? JSON.parse(record.securityAnalysis) : undefined,
          permissionGrant: record.permissionGrant ? JSON.parse(record.permissionGrant) : undefined,
          installResult: record.installResult ? JSON.parse(record.installResult) : undefined,
        };
      
      case 'app-delete':
        return {
          ...baseTask,
          taskType: 'app-delete',
          appId: record.appId,
          appName: record.appName,
          deletionMethod: record.deletionMethod || 'complete-cleanup',
        };
      
      case 'app-update':
        return {
          ...baseTask,
          taskType: 'app-update',
          appId: record.appId,
          currentVersion: record.currentVersion,
          targetVersion: record.targetVersion,
          updateUrl: record.updateUrl,
          backupPath: record.backupPath,
        };
      
      case 'backup':
        return {
          ...baseTask,
          taskType: 'backup',
          sourcePath: record.sourcePath,
          destinationPath: record.destinationPath,
          backupType: record.backupType,
          compressionLevel: record.compressionLevel,
        };
      
      case 'sync':
        return {
          ...baseTask,
          taskType: 'sync',
          sourcePath: record.sourcePath,
          destinationPath: record.destinationPath,
          syncMode: record.syncMode,
          conflictResolution: record.conflictResolution,
        };
      
      case 'build':
        return {
          ...baseTask,
          taskType: 'build',
          projectPath: record.projectPath,
          buildTarget: record.buildTarget,
          buildConfiguration: record.buildConfiguration,
          buildTools: record.buildTools ? JSON.parse(record.buildTools) : [],
        };
      
      case 'deploy':
        return {
          ...baseTask,
          taskType: 'deploy',
          deploymentTarget: record.deploymentTarget,
          deploymentMethod: record.deploymentMethod,
          environment: record.environment,
          rollbackEnabled: record.rollbackEnabled,
        };

      case 'terraform-apply': {
        const meta = baseTask.metadata ?? {};
        return {
          ...baseTask,
          taskType: 'terraform-apply',
          stackInstanceId: meta.stackInstanceId as string,
          stackTypeId: meta.stackTypeId as string,
          workspacePath: meta.workspacePath as string,
        };
      }

      case 'terraform-destroy': {
        const meta = baseTask.metadata ?? {};
        return {
          ...baseTask,
          taskType: 'terraform-destroy',
          stackInstanceId: meta.stackInstanceId as string,
          stackTypeId: meta.stackTypeId as string,
          workspacePath: meta.workspacePath as string,
        };
      }

      case 'inference-deploy': {
        const meta = baseTask.metadata ?? {};
        return {
          ...baseTask,
          taskType: 'inference-deploy',
          stackInstanceId: meta.stackInstanceId as string,
          stackTypeId: meta.stackTypeId as string,
          workspacePath: meta.workspacePath as string | undefined,
        };
      }

      case 'inference-destroy': {
        const meta = baseTask.metadata ?? {};
        return {
          ...baseTask,
          taskType: 'inference-destroy',
          stackInstanceId: meta.stackInstanceId as string,
          stackTypeId: meta.stackTypeId as string,
          workspacePath: meta.workspacePath as string | undefined,
        };
      }
      
      default:
        return {
          ...baseTask,
          taskType: 'generic',
        };
    }
  }
}

export const taskService = new TaskService(); 