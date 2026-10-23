const SENSITIVE_PATTERNS = [
  /api[_-]?key[:\s=]+[^\s]+/gi,
  /secret[:\s=]+[^\s]+/gi,
  /token[:\s=]+[^\s]+/gi,
  /password[:\s=]+[^\s]+/gi,
];

export function redactTerraformLogLine(line: string): string {
  let out = line;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, (m) => m.split(/[:=]/)[0] + ': [REDACTED]');
  }
  return out;
}
