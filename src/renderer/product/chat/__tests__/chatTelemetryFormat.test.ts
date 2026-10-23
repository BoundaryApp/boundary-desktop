import { describe, expect, it } from 'vitest';
import {
  formatContextGauge,
  formatPhaseLine,
  formatTokenCount,
  splitContextBar,
} from '../chatTelemetryFormat';

describe('formatContextGauge', () => {
  it('marks the empty placeholder so chrome can hide the meter', () => {
    const gauge = formatContextGauge(null);
    expect(gauge.empty).toBe(true);
    expect(gauge.showBar).toBe(false);
  });

  it('hides percent when context_max is absent', () => {
    const gauge = formatContextGauge({ contextUsed: 100, contextMax: null });
    expect(gauge.label).toBe('context max unknown');
    expect(gauge.showBar).toBe(false);
    expect(gauge.percentLabel).toBeNull();
    expect(gauge.empty).toBe(false);
  });

  it('never renders 0% when max unknown', () => {
    const gauge = formatContextGauge({ contextUsed: 0 });
    expect(gauge.percentLabel).toBeNull();
    expect(gauge.showBar).toBe(false);
  });

  it('shows used/max and percent when max is known', () => {
    const gauge = formatContextGauge({
      contextUsed: 18823,
      contextMax: 32000,
      contextPercent: 59,
    });
    expect(gauge.label).toContain('18.8k');
    expect(gauge.label).toContain('32k');
    expect(gauge.percentLabel).toBe('59%');
    expect(gauge.showBar).toBe(true);
  });

  it('prefixes ~ when estimated', () => {
    const gauge = formatContextGauge({
      contextUsed: 1000,
      contextMax: 8000,
      contextEstimated: true,
    });
    expect(gauge.label.startsWith('~')).toBe(true);
  });
});

describe('formatPhaseLine', () => {
  it('formats preparing with elapsed seconds', () => {
    expect(formatPhaseLine({ phase: 'preparing', elapsedSec: 3 })).toBe(
      'Preparing · 3s'
    );
  });

  it('formats tool with turn budget', () => {
    expect(
      formatPhaseLine({
        phase: 'tool',
        toolName: 'search_files',
        toolTurn: 2,
        maxTurns: 20,
      })
    ).toBe('search_files · 2 / 20');
  });

  it('formats generating with tok/s', () => {
    expect(
      formatPhaseLine({
        phase: 'generating',
        visibleTokens: 42,
        avgTps: 35,
      })
    ).toBe('42 tok · 35/s');
  });

  it('names the restart phase', () => {
    expect(
      formatPhaseLine({
        phase: 'restarting',
        toolName: 'OpenRouter',
      })
    ).toBe('Restarting assistant to apply OpenRouter…');
  });
});

describe('formatChannelHead', () => {
  it('uses #slug and omits a redundant title', async () => {
    const { formatChannelHead } = await import('../channelHead');
    expect(
      formatChannelHead({ slug: 'general', title: 'general' })
    ).toEqual({ title: '#general', subtitle: null });
  });

  it('keeps a distinct title as the subtitle', async () => {
    const { formatChannelHead } = await import('../channelHead');
    expect(
      formatChannelHead({ slug: 'general', title: 'Team standup' })
    ).toEqual({ title: '#general', subtitle: 'Team standup' });
  });
});

describe('formatTokenCount', () => {
  it('formats thousands', () => {
    expect(formatTokenCount(18823)).toBe('18.8k');
    expect(formatTokenCount(32000)).toBe('32k');
  });
});

describe('formatToolCardMeta / formatTurnStatsLine (shared)', () => {
  it('formats tool card meta and turn stats', async () => {
    const {
      formatToolCardMeta,
      formatTurnStatsLine,
      toHostRelativePath,
    } = await import('../../../../shared/hermesToolPaths');
    expect(
      formatToolCardMeta({
        name: 'search_files',
        status: 'running',
        turn: 2,
        maxTurns: 20,
      })
    ).toBe('Reading search_files · turn 2 of 20');
    expect(
      formatTurnStatsLine({
        prompt: 18823,
        generated: 708,
        visible: 7,
        ttftSec: 1.2,
        avgTps: 35,
      })
    ).toEqual([
      { label: 'prompt', value: '18.8k' },
      { label: 'generated', value: '708' },
      { label: 'visible', value: '7' },
      { label: 'TTFT', value: '1.2s' },
      { label: 'tok/s', value: '35' },
    ]);
    expect(toHostRelativePath('/opt/projects/x/a.md', '/opt/projects/x')).toBe(
      'a.md'
    );
  });
});

describe('splitContextBar', () => {
  const cats = [
    { id: 'system_prompt', tokens: 3000 },
    { id: 'tool_definitions', tokens: 5000 },
    { id: 'conversation', tokens: 2000 },
  ];

  it('splits the reported occupancy by category ratio', () => {
    const split = splitContextBar(20, cats);
    expect(split?.overhead).toBeCloseTo(16);
    expect(split?.conversation).toBeCloseTo(4);
  });

  it('never fills past the reported percent', () => {
    // 23.3k / 131.1k ≈ 18% — the bar stays there whatever the category totals are.
    const split = splitContextBar(18, [
      { id: 'system_prompt', tokens: 900_000 },
      { id: 'conversation', tokens: 400_000 },
    ]);
    expect(split!.overhead + split!.conversation).toBeCloseTo(18);
  });

  it('caps at 100', () => {
    const split = splitContextBar(140, cats);
    expect(split!.overhead + split!.conversation).toBeCloseTo(100);
  });

  it('returns null without a percent or categories', () => {
    expect(splitContextBar(null, cats)).toBeNull();
    expect(splitContextBar(20, [])).toBeNull();
    expect(splitContextBar(20, null)).toBeNull();
    expect(splitContextBar(20, [{ id: 'conversation', tokens: 0 }])).toBeNull();
  });
});
