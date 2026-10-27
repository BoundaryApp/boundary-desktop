import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOpenRouterAaCache,
  fetchOpenRouterAaBenchmarks,
  lookupAaBenchmarks,
  parseAaBenchmarksResponse,
} from '../openrouterAaBenchmarks';

describe('openrouterAaBenchmarks', () => {
  afterEach(() => {
    clearOpenRouterAaCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('parseAaBenchmarksResponse', () => {
    it('parses AA items and ignores other sources', () => {
      const byPermaslug = parseAaBenchmarksResponse({
        data: [
          {
            source: 'artificial-analysis',
            model_permaslug: 'openai/gpt-4o',
            intelligence_index: 71.2,
            coding_index: 65.8,
            agentic_index: 58.3,
          },
          {
            source: 'openrouter',
            model_permaslug: 'openai/gpt-4o',
            accuracy: 0.72,
          },
          {
            source: 'artificial-analysis',
            model_permaslug: 'anthropic/claude-sonnet-4',
            intelligence_index: null,
            coding_index: 80.1,
          },
        ],
      });

      expect(byPermaslug.get('openai/gpt-4o')).toEqual({
        intelligence: 71.2,
        coding: 65.8,
      });
      expect(byPermaslug.get('anthropic/claude-sonnet-4')).toEqual({
        coding: 80.1,
      });
      expect(byPermaslug.size).toBe(2);
    });
  });

  describe('lookupAaBenchmarks', () => {
    const byPermaslug = new Map([
      ['openai/gpt-4o', { intelligence: 71.2, coding: 65.8 }],
    ]);

    it('matches exact permaslug and :variant suffix', () => {
      expect(lookupAaBenchmarks('openai/gpt-4o', byPermaslug)).toEqual({
        intelligence: 71.2,
        coding: 65.8,
      });
      expect(lookupAaBenchmarks('openai/gpt-4o:free', byPermaslug)).toEqual({
        intelligence: 71.2,
        coding: 65.8,
      });
      expect(lookupAaBenchmarks('openai/gpt-4o:nitro', byPermaslug)).toEqual({
        intelligence: 71.2,
        coding: 65.8,
      });
    });

    it('does not fuzzy-match date-versioned ids', () => {
      expect(lookupAaBenchmarks('openai/gpt-4o-2024-11-20', byPermaslug)).toBeUndefined();
    });
  });

  describe('fetchOpenRouterAaBenchmarks', () => {
    it('fetches once then serves from cache', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            data: [
              {
                source: 'artificial-analysis',
                model_permaslug: 'openai/gpt-4o',
                intelligence_index: 71.2,
                coding_index: 65.8,
              },
            ],
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const first = await fetchOpenRouterAaBenchmarks({
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: { Authorization: 'Bearer sk-test' },
      });
      const second = await fetchOpenRouterAaBenchmarks({
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: { Authorization: 'Bearer sk-test' },
      });

      expect(first.get('openai/gpt-4o')).toEqual({ intelligence: 71.2, coding: 65.8 });
      expect(second.get('openai/gpt-4o')).toEqual({ intelligence: 71.2, coding: 65.8 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis'
      );
    });
  });
});
