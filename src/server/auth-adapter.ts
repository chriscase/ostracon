// Ostracon AuthAdapter contract (chriscase/abydonian#229).
//
// Decouples the codex GraphQL resolvers from the host app's specific auth
// system. The codex code only ever calls `requireCodexPermission(ctx, perm)`
// — it never touches Prisma, JWT secrets, or the host's role matrix
// directly.
//
// ─── Permissions the codex requests ────────────────────────────────────
//
// The codex resolvers request three string permissions:
//   - 'codex.read'   — list the tree, view notes, search, history, prefs
//   - 'codex.write'  — create / edit / rename / move / upload / revert
//   - 'codex.delete' — delete notes, delete folders, delete tags
//
// An adapter implementation is responsible for mapping these strings to
// whatever permission system the host uses (RBAC roles, scopes, capability
// tokens, ...).
//
// ─── Adapter contract ────────────────────────────────────────────────
//
// `requirePermission(ctx, perm)` MUST:
//   1. Return a `CodexUser` (with at least `email` + `id`) on success.
//   2. Throw an Error on failure. The error message becomes the GraphQL
//      response — keep it actionable but non-leaky.

export type CodexPermission = 'codex.read' | 'codex.write' | 'codex.delete';

export interface CodexUser {
  /** Opaque host-issued user identifier. The codex stores per-user prefs
   *  (recents + pinned) keyed by this; otherwise it's not interpreted. */
  id: string;
  /** Display name. Used as the git author name. */
  name?: string | null;
  /** Email. Used as the git author email. Required. */
  email: string;
}

/**
 * Adapter contract. Codex resolvers receive an instance of this via the
 * GraphQL context (`context.codexAuth`). Hosts implement it once and
 * register the implementation when building their GraphQL context.
 */
export interface AuthAdapter {
  /**
   * Verify the request has `permission` and return the calling user.
   * Throws on missing auth or insufficient permission. The thrown Error's
   * message surfaces to the GraphQL response — keep it actionable but
   * non-leaky.
   */
  requirePermission(
    context: unknown,
    permission: CodexPermission,
  ): Promise<CodexUser>;
}

/**
 * Resolve the codex auth adapter for a given GraphQL context. Codex
 * resolvers should call this rather than touching `context.codexAuth`
 * directly. Throws if no adapter is wired (a clear failure mode for hosts
 * that forget the integration step).
 */
export async function requireCodexPermission(
  context: { codexAuth?: AuthAdapter },
  permission: CodexPermission,
): Promise<CodexUser> {
  const adapter = context.codexAuth;
  if (!adapter) {
    throw new Error(
      'Ostracon: no AuthAdapter wired into context. Set `context.codexAuth = yourAdapter` when building the GraphQL context.',
    );
  }
  return adapter.requirePermission(context, permission);
}
