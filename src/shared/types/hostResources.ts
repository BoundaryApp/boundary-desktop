export const RESOURCE_BUCKET_IDS = ['app', 'stack', 'llm', 'rest'] as const;

export type ResourceBucketId = (typeof RESOURCE_BUCKET_IDS)[number];

export type ResourceBucketStatus =
  | 'measured'
  | 'not-detected'
  | 'not-running'
  | 'estimated'
  | 'warming';

export type ResourceBucketSample = {
  id: ResourceBucketId;
  /** Fraction of total host CPU capacity (0–1). */
  cpuShare: number;
  memoryBytes: number;
  /** Null until the slower disk cache lands. */
  diskBytes: number | null;
  status: ResourceBucketStatus;
  detail: string;
};

export type HostResourceHost = {
  displayName: string;
  cpuCores: number;
  memoryBytes: number;
  diskBytes: number;
};

export type HostResourceSnapshot = {
  collectedAt: string;
  host: HostResourceHost;
  buckets: Record<ResourceBucketId, ResourceBucketSample>;
  caveats: string[];
};
