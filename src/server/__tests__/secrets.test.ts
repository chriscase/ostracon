import { describe, it, expect } from 'vitest';
import { scanContent, hasSecrets } from '../secrets';

describe('scanContent', () => {
  it('flags AWS access keys', () => {
    const hits = scanContent('Some text AKIAIOSFODNN7EXAMPLE more text');
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe('aws-access-key');
    expect(hits[0].snippet).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('flags Stripe live keys', () => {
    const hits = scanContent('Stripe sk_live_abcdefghijklmnopqrstuvwxyz1234567890 here');
    expect(hits.find((h) => h.pattern === 'stripe-live-key')).toBeTruthy();
  });

  it('flags GitHub PAT', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    expect(hasSecrets(`token: ${token}`)).toBe(true);
  });

  it('flags OpenAI keys', () => {
    const key = 'sk-' + 'A'.repeat(48);
    expect(hasSecrets(`api: ${key}`)).toBe(true);
  });

  it('flags JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(hasSecrets(`jwt: ${jwt}`)).toBe(true);
  });

  it('flags private keys', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...';
    expect(hasSecrets(content)).toBe(true);
  });

  it('flags env-style secret assignments', () => {
    const hits = scanContent('JWT_SECRET=abcdefghijklmnopqrst1234567890');
    expect(hits.find((h) => h.pattern === 'env-secret-assignment')).toBeTruthy();
  });

  it('flags slack bot tokens', () => {
    const token = 'xoxb-1234567890-1234567890-' + 'a'.repeat(24);
    expect(hasSecrets(`slack: ${token}`)).toBe(true);
  });

  it('reports correct line numbers', () => {
    const text = `line one\nline two\nAKIAIOSFODNN7EXAMPLE\nline four`;
    const hits = scanContent(text);
    expect(hits[0].line).toBe(3);
  });

  it('returns empty for clean content', () => {
    const text = `# My Note\n\nThis is just markdown with [[wikilinks]] and a list:\n- one\n- two\n`;
    expect(scanContent(text)).toEqual([]);
    expect(hasSecrets(text)).toBe(false);
  });

  it('snippet redacts the secret value', () => {
    const hits = scanContent('Here is sk_live_abcdefghijklmnopqrstuvwxyz1234567890 in text');
    expect(hits[0].snippet).toContain('*');
    expect(hits[0].snippet).not.toContain('abcdefghijklmnop');
  });
});
