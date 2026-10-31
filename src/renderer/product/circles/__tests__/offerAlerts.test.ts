import { describe, expect, it } from 'vitest';
import type { CircleOfferView } from '../../../../shared/types/circles';
import { alertsFor, diffOffers } from '../offerAlerts';

const offer = (overrides: Partial<CircleOfferView> = {}): CircleOfferView => ({
  identity: 'bo',
  name: 'Bo',
  isMine: false,
  models: [{ id: 'qwen', tools: true }],
  available: true,
  away: false,
  online: true,
  ...overrides,
});

const kinds = (before: CircleOfferView[], after: CircleOfferView[]) =>
  diffOffers('Garden club', before, after).map((change) => change.kind);

describe('diffOffers', () => {
  it('names each change that alters what the user can do', () => {
    expect(kinds([], [offer()])).toEqual(['shared']);
    expect(kinds([offer()], [offer({ available: false })])).toEqual(['paused']);
    expect(kinds([offer({ available: false })], [offer()])).toEqual(['resumed']);
    expect(kinds([offer()], [offer({ online: false })])).toEqual(['offline']);
    expect(kinds([offer({ online: false })], [offer()])).toEqual(['online']);
    expect(kinds([offer()], [])).toEqual(['stopped']);
  });

  it('says nothing when the offer was unusable and stays so', () => {
    expect(kinds([], [offer({ available: false })])).toEqual([]);
    expect(kinds([offer({ available: false })], [offer({ available: false, online: false })])).toEqual([]);
    expect(kinds([offer({ online: false })], [offer({ available: false })])).toEqual([]);
  });

  it('ignores what makes no difference to the user', () => {
    expect(kinds([offer()], [offer({ away: true, name: 'Robert' })])).toEqual([]);
  });

  it('reports models added to and dropped from a usable offer', () => {
    const before = offer({ models: [{ id: 'qwen', tools: true }] });
    const after = offer({ models: [{ id: 'llama', tools: false }] });
    expect(diffOffers('Garden club', [before], [after]).map(({ kind, models }) => [kind, models])).toEqual([
      ['shared', ['llama']],
      ['stopped', ['qwen']],
    ]);
  });

  it("never reports the user's own offer", () => {
    const mine = offer({ isMine: true });
    expect(kinds([], [mine])).toEqual([]);
    expect(kinds([mine], [{ ...mine, available: false }])).toEqual([]);
    expect(kinds([mine], [])).toEqual([]);
  });
});

describe('alertsFor', () => {
  const change = (circle: string) => diffOffers(circle, [offer()], [offer({ online: false })])[0];

  it('words a change by what the user can now do', () => {
    expect(alertsFor(diffOffers('Garden club', [offer()], [offer({ available: false })]))[0].text).toBe(
      "Bo paused qwen in Garden club. You can't use it until Bo resumes."
    );
  });

  it('collapses one provider across Circles into one sentence', () => {
    expect(alertsFor([change('Garden club'), change('Workshop')])).toEqual([
      {
        provider: 'bo',
        text: "Bo went offline. You can't use qwen from Garden club and Workshop until Bo is back.",
      },
    ]);
  });

  it('keeps one toast for different changes from one provider, and one per provider', () => {
    const paused = diffOffers('Workshop', [offer()], [offer({ available: false })])[0];
    const other = { ...change('Workshop'), provider: 'cy', name: 'Cy' };
    const alerts = alertsFor([change('Garden club'), paused, other]);
    expect(alerts.map((alert) => alert.provider)).toEqual(['bo', 'cy']);
    expect(alerts[0].text).toContain('Bo went offline.');
    expect(alerts[0].text).toContain('Bo paused qwen in Workshop.');
  });

  it('shortens a long model list', () => {
    const models = ['a', 'b', 'c'].map((id) => ({ id, tools: true }));
    expect(alertsFor(diffOffers('Garden club', [], [offer({ models })]))[0].text).toBe(
      'Bo shared a and 2 more with Garden club. You can use them now.'
    );
  });
});
