# Ostracon

A markdown vault editor for the modern scribe. Browse, edit, search, and version-control an [Obsidian](https://obsidian.md)-shaped vault from any web app.

> _An ostracon (plural: ostraca) is a piece of broken pottery that ancient Egyptians and Greeks used as a cheap notebook — receipts, letters, school exercises, doodles. Conceptually: each note is an ostracon, the vault is the collection._

## Features

- **Vault browser**: tree view, force-graph view, full-text search, tag browser
- **Wikilink-aware editing**: rename a note → every `[[link]]` in the vault is rewritten in one atomic git commit (every form: `[[t]]`, `[[t|alias]]`, `[[t#anchor]]`, `![[embed]]`, folder-hinted, code-block-skipped)
- **Full CRUD on notes and folders**: rename, delete, create, move (drag-and-drop), with auto-managed-path guards
- **Attachments**: drag-drop / paste / button uploads to `_attachments/` with embed insertion; inline image rendering in preview
- **History + revert**: per-note `git log --follow` view with colorized diffs; one-click revert to any past commit
- **Find-and-replace**: vault-wide preview-then-apply, regex / wikilink-aware modes, glob scoping
- **Bulk ops**: tree multi-select (Shift / Cmd-click), batch move / tag / delete
- **Per-user prefs**: pinned notes + recents sidebar
- **Keyboard-first**: Cmd+S save, Cmd+K palette, Cmd+P quick-open, Cmd+Shift+F find-replace, Cmd+/ help
- **Pluggable adapters**: auth, navigation, GraphQL client, theme — drop into any Next.js host with any auth system

## Status

**v0.1.0**: production-ready inside [`chriscase/abydonian`](https://github.com/chriscase/abydonian); contracts stable; not yet exercised by other hosts. Repo private during burn-in; flipping public when stable.

## Install

Via git URL (no npm publish — see [#6](https://github.com/chriscase/ostracon/issues/6) for rationale):

```json
{
  "dependencies": {
    "@chriscase/ostracon": "github:chriscase/ostracon#v0.1.0"
  }
}
```

## Use

Two halves, three subpath imports:

```ts
// Server: full Node runtime — git, fs, sync coordinator, GraphQL field configs
import {
  saveNote, renameNote, deleteNote,
  type AuthAdapter, requireCodexPermission,
} from '@chriscase/ostracon/server';

// Server (browser-safe subset): types + frontmatter + wikilinks + auto-managed
import { parseNote, serializeNote, type Frontmatter } from '@chriscase/ostracon/server/client';

// UI: React components + adapter context
import {
  CodexBrowser, CodexTagBrowser, CodexRoute,
  CodexAdaptersProvider,
} from '@chriscase/ostracon/ui';
```

### Minimal Next.js wiring

Implement an `AuthAdapter` for your host's auth system and wire it into your GraphQL context:

```ts
// app/api/graphql/route.ts
import type { AuthAdapter } from '@chriscase/ostracon/server';
import { getCurrentUser } from '@/lib/auth';

const codexAuth: AuthAdapter = {
  async requirePermission(context, permission) {
    const user = await getCurrentUser(context);
    if (!user) throw new Error('Not authenticated');
    if (!user.permissions.has(permission)) throw new Error('Insufficient permission');
    return { id: user.id, name: user.name, email: user.email };
  },
};

const handler = startServerAndCreateNextHandler(server, {
  context: async (req) => ({ prisma, codexAuth, /* ...your context */ }),
});
```

Wrap your codex pages in the adapter provider so the UI knows how to navigate + run GraphQL:

```tsx
// app/codex/page.tsx
'use client';
import { CodexAdaptersProvider, CodexBrowser } from '@chriscase/ostracon/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { graphqlClient } from '@/lib/graphql';

export default function CodexPage() {
  return (
    <CodexAdaptersProvider
      navigation={{ Link, useRouter: () => useRouter() }}
      graphql={graphqlClient}
    >
      <CodexBrowser view="welcome" />
    </CodexAdaptersProvider>
  );
}
```

The Prisma model for per-user prefs (recents + pinned) lives in your schema:

```prisma
model CodexUserPref {
  userId      String   @id
  recentPaths String[] @default([])
  pinnedPaths String[] @default([])
  updatedAt   DateTime @updatedAt
}
```

## Architecture

- `src/server/lib/sync.ts` — single-mutex git pipeline (every vault write goes through here, ensuring atomic commits + secret-scan + auto-managed guard + debounced push)
- `src/server/lib/auth-adapter.ts` — `AuthAdapter` contract; the codex never imports your host's auth directly
- `src/server/graphql/` — GraphQL types + field configs for queries/mutations (compose into your existing schema)
- `src/ui/CodexAdapters.tsx` — React-context surface for navigation / GraphQL client / theme adapters

## Repo policy

- **No npm publish for now**: install via git URL deps. Same OSS reach, no registry to manage. ([#6](https://github.com/chriscase/ostracon/issues/6))
- **Private during burn-in**: flipped public when Tier-3 features are stable. ([#7](https://github.com/chriscase/ostracon/issues/7))
- **License**: Apache-2.0 (explicit patent grant — important for corporate adopters). See `LICENSE`.

## Origins

Extracted from [`chriscase/abydonian`](https://github.com/chriscase/abydonian) on 2026-05-03. The plan + execution history is in `chriscase/AbydosCodex/80 - Daily/2026/05/2026-05-02.md` (private vault).
