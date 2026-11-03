import type { CircleSnapshot } from '../../../../shared/types/circles';

/** "4 people · 3 online". */
export function peopleLine(circle: CircleSnapshot): string {
  const people = circle.members.length;
  const online = circle.members.filter((member) => member.online).length;
  return `${people} ${people === 1 ? 'person' : 'people'} · ${online} online`;
}
