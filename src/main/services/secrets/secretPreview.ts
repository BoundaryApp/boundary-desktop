import type { SecretPreview } from '../../../shared/types/secrets';
import { maskSecret } from '../../../shared/utils/secretPreview';

export function secretPreview(value: string | null | undefined): SecretPreview {
  if (!value) return { configured: false };
  return {
    configured: true,
    preview: maskSecret(value),
  };
}

