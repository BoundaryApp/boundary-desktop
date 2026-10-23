import { describe, expect, it } from 'vitest';
import {
  formatAaBenchmarks,
  formatContextLength,
  formatListedModelMeta,
  formatModelPricing,
  formatUsdPerMillionTokens,
  getModelPromptPricePerToken,
} from '../../../shared/modelListingDisplay';

describe('modelListingDisplay', () => {
  describe('formatUsdPerMillionTokens', () => {
    it('formats fractional and whole dollar amounts', () => {
      expect(formatUsdPerMillionTokens('0.00000075')).toBe('$0.75');
      expect(formatUsdPerMillionTokens('0.000003')).toBe('$3');
      expect(formatUsdPerMillionTokens('0.000015')).toBe('$15');
    });

    it('returns undefined for invalid values', () => {
      expect(formatUsdPerMillionTokens('')).toBeUndefined();
      expect(formatUsdPerMillionTokens('abc')).toBeUndefined();
    });
  });

  describe('formatModelPricing', () => {
    it('formats prompt and completion as $/M', () => {
      expect(
        formatModelPricing({
          promptPerToken: '0.00000075',
          completionPerToken: '0.00000375',
        })
      ).toBe('$0.75 / $3.75');
    });

    it('treats both zero prices as Free', () => {
      expect(
        formatModelPricing({
          promptPerToken: '0',
          completionPerToken: '0',
        })
      ).toBe('Free');
    });

    it('shows a single side when the other is missing', () => {
      expect(formatModelPricing({ promptPerToken: '0.000003' })).toBe('$3');
      expect(formatModelPricing({ completionPerToken: '0.000015' })).toBe('$15');
      expect(formatModelPricing({ promptPerToken: '0' })).toBe('$0');
    });

    it('returns undefined when pricing is empty', () => {
      expect(formatModelPricing(undefined)).toBeUndefined();
      expect(formatModelPricing({})).toBeUndefined();
    });
  });

  describe('formatContextLength', () => {
    it('formats millions and thousands compactly', () => {
      expect(formatContextLength(1_048_576)).toBe('1M');
      expect(formatContextLength(200_000)).toBe('200K');
      expect(formatContextLength(128_000)).toBe('128K');
      expect(formatContextLength(8192)).toBe('8K');
    });

    it('returns undefined for missing or invalid values', () => {
      expect(formatContextLength(undefined)).toBeUndefined();
      expect(formatContextLength(0)).toBeUndefined();
      expect(formatContextLength(-1)).toBeUndefined();
    });
  });

  describe('formatAaBenchmarks', () => {
    it('formats intelligence and coding as rounded integers', () => {
      expect(formatAaBenchmarks({ intelligence: 71.2, coding: 65.8 })).toBe('Int 71 · Code 66');
    });

    it('shows a single side when the other is missing', () => {
      expect(formatAaBenchmarks({ intelligence: 71.2 })).toBe('Int 71');
      expect(formatAaBenchmarks({ coding: 65.8 })).toBe('Code 66');
    });

    it('returns undefined when empty', () => {
      expect(formatAaBenchmarks(undefined)).toBeUndefined();
      expect(formatAaBenchmarks({})).toBeUndefined();
    });
  });

  describe('formatListedModelMeta', () => {
    it('joins price and context with a middle dot', () => {
      expect(
        formatListedModelMeta({
          pricing: {
            promptPerToken: '0.00000075',
            completionPerToken: '0.00000375',
          },
          contextLength: 1_048_576,
        })
      ).toBe('$0.75 / $3.75 · 1M ctx');
    });

    it('omits missing parts', () => {
      expect(formatListedModelMeta({ contextLength: 200_000 })).toBe('200K ctx');
      expect(
        formatListedModelMeta({
          pricing: { promptPerToken: '0', completionPerToken: '0' },
        })
      ).toBe('Free');
      expect(formatListedModelMeta({})).toBeUndefined();
    });
  });

  describe('getModelPromptPricePerToken', () => {
    it('returns the numeric prompt price', () => {
      expect(
        getModelPromptPricePerToken({
          pricing: { promptPerToken: '0.00000075' },
        })
      ).toBe(0.00000075);
      expect(
        getModelPromptPricePerToken({
          pricing: { promptPerToken: '0' },
        })
      ).toBe(0);
    });

    it('returns undefined when prompt price is missing or invalid', () => {
      expect(getModelPromptPricePerToken({})).toBeUndefined();
      expect(getModelPromptPricePerToken({ pricing: {} })).toBeUndefined();
      expect(
        getModelPromptPricePerToken({
          pricing: { promptPerToken: 'abc' },
        })
      ).toBeUndefined();
    });
  });
});
