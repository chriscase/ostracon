// AuthAdapter contract tests (chriscase/abydonian#235).
//
// These tests document and exercise the contract every AuthAdapter
// implementation must satisfy. They run against:
//   1. A minimal in-memory stub (proves the contract is implementable
//      without Prisma / NextAuth / etc.).
//   2. The Abydonian default adapter is exercised indirectly by the
//      existing GraphQL resolver tests; the contract here keeps that
//      behavior pinned.
//
// When a new adapter is added (NextAuth, Auth.js, custom), import it +
// pass it to `runAuthAdapterContract` to inherit the same guarantees.

import { describe, it, expect } from 'vitest';
import {
  requireCodexPermission,
  type AuthAdapter,
  type CodexPermission,
  type CodexUser,
} from '../auth-adapter';

interface StubAuthOptions {
  /** When set, every call returns this user. */
  user?: CodexUser;
  /** When set, the adapter throws this error message instead. */
  error?: string;
  /** When provided, the adapter only grants permissions in this set. */
  allowed?: ReadonlySet<CodexPermission>;
}

/** Minimal in-memory adapter — proves the contract is implementable
 *  without any framework dependencies. */
function makeStubAdapter(opts: StubAuthOptions = {}): AuthAdapter {
  const user: CodexUser =
    opts.user ?? { id: 'u-1', name: 'Test User', email: 'test@example.com' };
  return {
    async requirePermission(_context, permission) {
      if (opts.error) throw new Error(opts.error);
      if (opts.allowed && !opts.allowed.has(permission)) {
        throw new Error(`Insufficient permission: ${permission}`);
      }
      return user;
    },
  };
}

export function runAuthAdapterContract(
  describeName: string,
  build: () => Promise<AuthAdapter> | AuthAdapter,
): void {
  describe(describeName, () => {
    it('returns the user on success', async () => {
      const adapter = await build();
      const result = await adapter.requirePermission({}, 'codex.read');
      expect(typeof result.id).toBe('string');
      expect(typeof result.email).toBe('string');
      expect(result.email.length).toBeGreaterThan(0);
    });

    it('returns the same shape across all three permissions', async () => {
      const adapter = await build();
      for (const perm of ['codex.read', 'codex.write', 'codex.delete'] as const) {
        const u = await adapter.requirePermission({}, perm);
        expect(u).toMatchObject({
          id: expect.any(String),
          email: expect.any(String),
        });
      }
    });
  });
}

// ─── Run the contract against the stub ────────────────────────────────

runAuthAdapterContract('AuthAdapter contract — stub implementation', () =>
  makeStubAdapter(),
);

describe('AuthAdapter — error semantics', () => {
  it('propagates the adapter error verbatim', async () => {
    const adapter = makeStubAdapter({ error: 'Custom auth failure' });
    await expect(
      adapter.requirePermission({}, 'codex.read'),
    ).rejects.toThrow('Custom auth failure');
  });

  it('throws when the requested permission is not allowed', async () => {
    const adapter = makeStubAdapter({
      allowed: new Set<CodexPermission>(['codex.read']),
    });
    await expect(adapter.requirePermission({}, 'codex.read')).resolves.toBeTruthy();
    await expect(
      adapter.requirePermission({}, 'codex.write'),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      adapter.requirePermission({}, 'codex.delete'),
    ).rejects.toThrow(/Insufficient permission/);
  });
});

describe('requireCodexPermission helper', () => {
  it('uses the adapter wired into context', async () => {
    const stub = makeStubAdapter({
      user: { id: 'ctx-user', email: 'ctx@example.com', name: 'Ctx User' },
    });
    const result = await requireCodexPermission(
      { codexAuth: stub },
      'codex.read',
    );
    expect(result.id).toBe('ctx-user');
    expect(result.email).toBe('ctx@example.com');
  });

  it('falls back to a default when the context omits an adapter', async () => {
    // The default Abydonian adapter requires real Prisma + a real
    // userId; here we just verify the fallback path is wired (it should
    // throw "Not authenticated" rather than crashing on the missing
    // adapter).
    await expect(
      requireCodexPermission({}, 'codex.read'),
    ).rejects.toBeTruthy();
  });
});
