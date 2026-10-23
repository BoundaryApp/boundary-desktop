export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 2) return '*'.repeat(value.length);

  const edgeLength = value.length <= 4 ? 1 : value.length <= 12 ? 2 : 4;
  const hiddenLength = Math.max(1, value.length - edgeLength * 2);

  return `${value.slice(0, edgeLength)}${'*'.repeat(hiddenLength)}${value.slice(-edgeLength)}`;
}

