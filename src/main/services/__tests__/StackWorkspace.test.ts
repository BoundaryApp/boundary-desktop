import { describe, it, expect } from 'vitest';
import {
  formatTfvarValue,
  getTfvarsPath,
  getModuleDir,
} from '../infrastructure/StackWorkspace';
import { redactTerraformLogLine } from '../infrastructure/terraformLogRedact';

describe('getTfvarsPath', () => {
  it('places tfvars in the module directory where terraform runs', () => {
    const instanceId = 'test-instance-123';
    expect(getTfvarsPath(instanceId)).toBe(
      `${getModuleDir(instanceId)}/terraform.tfvars`.replace(/\\/g, '/')
    );
    expect(getTfvarsPath(instanceId)).toContain('/module/terraform.tfvars');
  });
});

describe('formatTfvarValue', () => {
  it('formats strings with quotes and escapes', () => {
    expect(formatTfvarValue('hello')).toBe('"hello"');
    expect(formatTfvarValue('a"b')).toBe('"a\\"b"');
  });

  it('formats booleans and numbers', () => {
    expect(formatTfvarValue(true)).toBe('true');
    expect(formatTfvarValue(42)).toBe('42');
  });
});

describe('redactTerraformLogLine', () => {
  it('redacts api keys in log lines', () => {
    const line = 'api_key=supersecret12345';
    expect(redactTerraformLogLine(line)).not.toContain('supersecret');
    expect(redactTerraformLogLine(line)).toContain('REDACTED');
  });
});
