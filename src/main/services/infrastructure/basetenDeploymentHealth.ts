import type { StackHealthStatus } from '../../../shared/types/infrastructure';
import type { BasetenDeploymentSnapshot, BasetenDeploymentStatus } from './BasetenApiClient';

export { BASETEN_BILLING_URL } from '../../../shared/types/infrastructure';

const WARMING_DEPLOYMENT_STATUSES = new Set<BasetenDeploymentStatus>([
  'BUILDING',
  'DEPLOYING',
  'LOADING_MODEL',
  'UPDATING',
]);

const IDLE_DEPLOYMENT_STATUSES = new Set<BasetenDeploymentStatus>(['SCALED_TO_ZERO']);

const FAILED_DEPLOYMENT_STATUSES = new Set<BasetenDeploymentStatus>([
  'DEPLOY_FAILED',
  'BUILD_FAILED',
  'BUILD_STOPPED',
  'UNHEALTHY',
  'FAILED',
  'DEACTIVATING',
]);

const INACTIVE_BILLING_MESSAGE =
  'Deployment is inactive — add a payment method in Baseten to activate it (free credits may be exhausted).';

export function mapBasetenDeploymentToHealth(
  deployment: BasetenDeploymentSnapshot
): { status: StackHealthStatus; message?: string; deployReady: boolean } {
  const { status, activeReplicaCount } = deployment;

  if (IDLE_DEPLOYMENT_STATUSES.has(status)) {
    return {
      status: 'idle',
      message: 'Scaled to zero — send a request to wake the endpoint',
      deployReady: true,
    };
  }

  if (status === 'WAKING_UP') {
    return {
      status: 'idle',
      message: 'Waking up from scale-to-zero',
      deployReady: true,
    };
  }

  if (status === 'ACTIVE' && activeReplicaCount === 0) {
    return {
      status: 'idle',
      message: 'No active replicas — endpoint may be scaling',
      deployReady: true,
    };
  }

  if (status === 'ACTIVE' && activeReplicaCount > 0) {
    return { status: 'healthy', deployReady: true };
  }

  if (status === 'INACTIVE') {
    return {
      status: 'blocked',
      message: INACTIVE_BILLING_MESSAGE,
      deployReady: false,
    };
  }

  if (WARMING_DEPLOYMENT_STATUSES.has(status)) {
    return {
      status: 'unknown',
      message: `Baseten deployment: ${status}`,
      deployReady: false,
    };
  }

  if (FAILED_DEPLOYMENT_STATUSES.has(status)) {
    return {
      status: 'unhealthy',
      message: `Baseten deployment: ${status}`,
      deployReady: false,
    };
  }

  return {
    status: 'unknown',
    message: `Baseten deployment: ${status}`,
    deployReady: false,
  };
}

export function isBasetenDeployReadyHealth(status: StackHealthStatus): boolean {
  return status === 'healthy' || status === 'idle';
}
