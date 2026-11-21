import { describe, expect, it } from 'vitest';
import type { PoolExclusion } from '../../../../shared/types/confidentialState';
import {
  CONFIDENTIAL_COPY,
  exclusionText,
  formatLastThirtyDays,
  formatTurnCost,
} from '../confidentialCopy';

const ctx = { level: 'C' as const, floor: 'B' as const, precision: 'fp4' as const, lowestPrecision: 'fp8' as const };

describe('exclusionText', () => {
  it('names the level and the minimum for a provider below it', () => {
    expect(exclusionText('below-level', ctx)).toBe('Level C is below your minimum, B.');
  });

  it('names the precision and the lowest one allowed', () => {
    expect(exclusionText('precision', ctx)).toBe('Runs at fp4, below your lowest precision, fp8.');
    expect(exclusionText('precision', { ...ctx, precision: null })).toBe('Runs below your lowest precision, fp8.');
  });

  it('uses the prototype’s sentences for not added and unstated precision', () => {
    expect(exclusionText('not-added', ctx)).toBe('Not added. Pools only use providers you add.');
    expect(exclusionText('precision-unstated', ctx)).toBe('Doesn’t state its precision, and your pool only takes stated ones.');
  });

  it('tells the user to enter a key again when it can’t be read', () => {
    expect(exclusionText('key-unavailable', ctx)).toBe(
      'Boundary can’t read the key you stored for it. Remove it and add it again with its key.'
    );
  });

  it('says when an added provider doesn’t offer the model', () => {
    expect(exclusionText('model-not-offered', ctx)).toBe('Doesn’t offer this model.');
  });

  it('has a sentence for every reason', () => {
    const reasons: PoolExclusion[] = [
      'not-added',
      'below-level',
      'precision',
      'precision-unstated',
      'no-price',
      'no-tools',
      'context',
      'input-types',
      'key-unavailable',
      'no-balance',
      'rate-limited',
      'attestation-failed',
      'unhealthy',
      'model-not-offered',
    ];
    for (const reason of reasons) expect(exclusionText(reason, ctx)).toMatch(/\.$/);
  });
});

describe('formatTurnCost', () => {
  it('shows three decimals under ten cents and two above', () => {
    expect(formatTurnCost(0.015)).toBe('$0.015');
    expect(formatTurnCost(0.17)).toBe('$0.17');
  });
});

describe('formatLastThirtyDays', () => {
  it('counts turns and reads the cost as about, or under a cent', () => {
    expect(formatLastThirtyDays(1, 0.61)).toBe('1 turn · about $0.61');
    expect(formatLastThirtyDays(41, 0.61)).toBe('41 turns · about $0.61');
    expect(formatLastThirtyDays(3, 0.004)).toBe('3 turns · under $0.01');
    expect(formatLastThirtyDays(0, 0)).toBe('0 turns · about $0.00');
  });
});

describe('the private project stop', () => {
  it('names the project’s level, and the model when no added provider carries it', () => {
    expect(CONFIDENTIAL_COPY.privateStop.title('A')).toBe('No provider you’ve added meets this project’s level A.');
    expect(CONFIDENTIAL_COPY.privateStop.noneAdded('Qwen 3.8 27B')).toBe('You haven’t added a provider that carries Qwen 3.8 27B.');
  });
});
