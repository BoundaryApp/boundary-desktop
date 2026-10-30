/**
 * What kind of address a peer or this device is reached at, for diagnostics that must not carry
 * the IP itself. A relayed connection shows the relay's class.
 */
export type AddressClass = 'none' | 'loopback' | 'lan' | 'cgnat' | 'link-local' | 'public' | 'ipv6' | 'unknown';

export function addressClass(host: string | null | undefined): AddressClass {
  if (!host) return 'none';
  if (host.includes(':')) return host === '::1' ? 'loopback' : 'ipv6';
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return 'unknown';
  const [a, b] = parts;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'link-local';
  return 'public';
}
