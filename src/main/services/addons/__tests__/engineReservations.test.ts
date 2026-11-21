import { describe, expect, it, vi } from 'vitest';

vi.mock('../addonComposeState', () => ({ installedAddonsHere: async (): Promise<string[]> => [] }));

const { engineReservationsMiB } = await import('../engineReservations');
const { TWENTY_ENTRY, ACTUAL_ENTRY, EMAIL_ENTRY, LIGHTRAG_ENTRY, N8N_ENTRY } = await import('../addonCatalog');

describe('engineReservationsMiB', () => {
  it('reserves nothing when nothing optional is on', async () => {
    expect(await engineReservationsMiB()).toEqual({});
  });

  it('counts an add-on being installed that asked for room', async () => {
    expect(await engineReservationsMiB({ pending: () => ({ twenty: 2208 }) })).toEqual({ twenty: 2208 });
  });

  it('reserves for each installed add-on that is on, n8n and LightRAG among them', async () => {
    expect(
      await engineReservationsMiB({
        addons: async () => ['lightrag', 'n8n', 'twenty', 'actual', 'email'],
      })
    ).toEqual({
      lightrag: LIGHTRAG_ENTRY.reserveMiB,
      n8n: N8N_ENTRY.reserveMiB,
      twenty: TWENTY_ENTRY.reserveMiB,
      actual: ACTUAL_ENTRY.reserveMiB,
      email: EMAIL_ENTRY.reserveMiB,
    });
  });
});
