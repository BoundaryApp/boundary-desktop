import { describe, expect, it } from 'vitest';
import { parseServiceOffer } from '../serviceOffers';

const offer = { kind: 'twenty', name: 'Book club CRM', levels: ['read', 'write'], available: true, away: false };

describe('parseServiceOffer', () => {
  it('reads a valid offer and trims its name', () => {
    expect(parseServiceOffer({ ...offer, name: '  Book club CRM ' })).toEqual(offer);
    expect(parseServiceOffer({ ...offer, levels: ['read'] })).toEqual({ ...offer, levels: ['read'] });
  });

  it('puts levels in one order and drops repeats', () => {
    expect(parseServiceOffer({ ...offer, levels: ['write', 'read', 'read'] })?.levels).toEqual(['read', 'write']);
  });

  it.each([
    ['null', null],
    ['an array', [offer]],
    ['an unknown kind', { ...offer, kind: 'actual' }],
    ['an empty name', { ...offer, name: '  ' }],
    ['a long name', { ...offer, name: 'x'.repeat(101) }],
    ['write without read', { ...offer, levels: ['write'] }],
    ['no levels', { ...offer, levels: [] }],
    ['an unknown level', { ...offer, levels: ['read', 'admin'] }],
    ['a missing flag', { ...offer, away: undefined }],
    ['a flag that isn’t a boolean', { ...offer, available: 'yes' }],
  ])('refuses %s', (_name, value) => {
    expect(parseServiceOffer(value)).toBeNull();
  });
});
