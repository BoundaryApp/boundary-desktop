import type { SecretPreview } from './secrets';

export type SensitiveConfigKey = 'apiKey' | 'secretToken' | 'databaseUrl';
export type ConfigKey = SensitiveConfigKey | 'webhookUrl' | 'registryUrl';

export interface AppConfig {
  apiKey: SecretPreview;
  secretToken: SecretPreview;
  webhookUrl: string;
  databaseUrl: SecretPreview;
  registryUrl: string;
}

export interface AppConfigInput {
  apiKey?: string;
  secretToken?: string;
  webhookUrl: string;
  databaseUrl?: string;
  registryUrl: string;
}

export const sensitiveConfigKeys: SensitiveConfigKey[] = [
  'apiKey',
  'secretToken',
  'databaseUrl',
];

