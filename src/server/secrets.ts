// Secret scanner — refuse to save vault content that looks like leaked
// credentials. Run before every saveNote/createNote.
//
// This is a *reasonable-effort* check, not a guarantee — high entropy alone
// can't distinguish a hash from a JWT_SECRET from a Base64-encoded PNG.
// Treat this as a guard rail, not a vault. Real secret scanning happens at
// commit-time on the GitHub side too.

export interface SecretHit {
  /** Short identifier of the pattern that matched. */
  pattern: string;
  /** 1-indexed line number in the input. */
  line: number;
  /** Up to 80 chars of context, with the secret itself redacted. */
  snippet: string;
}

interface PatternRule {
  name: string;
  /** Must use the `g` flag for findAll() to work. */
  re: RegExp;
}

const PATTERNS: PatternRule[] = [
  // Provider-specific tokens — high signal.
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-secret-key', re: /\b[A-Za-z0-9/+]{40}\b(?=\s|$|["'])/g },
  { name: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
  { name: 'stripe-test-key', re: /\bsk_test_[A-Za-z0-9]{24,}\b/g },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
  { name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{36}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'slack-bot-token', re: /\bxox[abp]-[0-9]{10,12}-[0-9]{10,12}-[A-Za-z0-9]{24,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'private-key', re: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)?\s*PRIVATE KEY-----/g },

  // Heuristic: an env-style assignment that names a secret AND has a non-empty value.
  // Catches `JWT_SECRET=abc123`, `DATABASE_URL=postgres://user:pass@…`. We deliberately
  // miss multi-line YAML/JSON — those need a different scanner.
  {
    name: 'env-secret-assignment',
    re: /\b(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY))\s*[:=]\s*["']?[A-Za-z0-9/_+\-.]{16,}["']?/g,
  },
];

/** Truncate around the match position so we never echo the full secret back. */
function makeSnippet(text: string, matchStart: number, matchLength: number): string {
  const lineStart = text.lastIndexOf('\n', matchStart - 1) + 1;
  const lineEnd = text.indexOf('\n', matchStart);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const matchLocal = matchStart - lineStart;
  const before = line.slice(Math.max(0, matchLocal - 12), matchLocal);
  const masked = '*'.repeat(Math.min(8, Math.max(3, matchLength)));
  const after = line.slice(matchLocal + matchLength, matchLocal + matchLength + 12);
  return `${before}${masked}${after}`.trim().slice(0, 80);
}

function lineNumber(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

export function scanContent(content: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const rule of PATTERNS) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(content)) !== null) {
      hits.push({
        pattern: rule.name,
        line: lineNumber(content, m.index),
        snippet: makeSnippet(content, m.index, m[0].length),
      });
      // Avoid infinite loops on zero-width matches (shouldn't happen here, but safe).
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  return hits;
}

export function hasSecrets(content: string): boolean {
  return scanContent(content).length > 0;
}
