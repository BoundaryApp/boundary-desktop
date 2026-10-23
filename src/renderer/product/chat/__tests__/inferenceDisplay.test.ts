import { describe, expect, it } from 'vitest';
import {
  formatInferenceChipTitle,
  formatInferenceProvenance,
  shortModelId,
} from '../../../../shared/inferenceDisplay';

describe('inferenceDisplay', () => {
  it('shortens OpenRouter ids after the last slash', () => {
    expect(shortModelId('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
    expect(shortModelId('qwen3:14b')).toBe('qwen3:14b');
  });

  it('formats chip title and provenance', () => {
    expect(formatInferenceChipTitle('local', 'qwen3:14b')).toBe('Local · qwen3:14b');
    expect(formatInferenceProvenance('app-default')).toBe('from app default');
    expect(formatInferenceProvenance('project-default')).toBe('from project default');
    expect(formatInferenceProvenance('chat-override')).toBe('overridden for this chat');
    expect(formatInferenceProvenance('app-default', { applying: true })).toBe('applying…');
    expect(formatInferenceProvenance('app-default', { unreachable: true })).toBe(
      'unreachable'
    );
  });
});
