// EventAdapter contract — emit vault-mutation events for downstream consumers.
//
// Hosts that maintain derived state (Postgres search index, comment refcount,
// audit log, embedding refresh) register an implementation; sync coordinator
// calls into it after every successful mutation. Default is no-op so existing
// hosts don't break.
//
// All event kinds carry the post-mutation `commitSha` + the resolved
// `CodexUser` who triggered the change. Note-scoped events carry the stable
// frontmatter UUID — that's the safe key for DB-backed features (survives
// renames).

import type { CodexUser } from './auth-adapter';

export type VaultEvent =
  | {
      kind: 'note.saved';
      uuid: string;
      path: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'note.created';
      uuid: string;
      path: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'note.renamed';
      uuid: string | undefined;
      oldPath: string;
      newPath: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'note.moved';
      uuid: string | undefined;
      oldPath: string;
      newPath: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'note.deleted';
      uuid: string | undefined;
      path: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'note.reverted';
      uuid: string | undefined;
      path: string;
      commitSha: string;
      toSha: string;
      author: CodexUser;
    }
  | {
      kind: 'folder.created';
      path: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'folder.renamed';
      oldPath: string;
      newPath: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'folder.deleted';
      path: string;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'attachment.uploaded';
      path: string;
      size: number;
      commitSha: string;
      author: CodexUser;
    }
  | {
      kind: 'vault.bulk-pull';
      /** Commit SHAs pulled in this batch (HEAD-first). */
      commitShas: string[];
      /** Vault-relative paths that changed in those commits. */
      changedPaths: string[];
    }
  | {
      kind: 'vault.find-replace-applied';
      commitSha: string;
      changedPaths: string[];
      totalReplacements: number;
      author: CodexUser;
    }
  | {
      kind: 'vault.tag-renamed';
      oldTag: string;
      newTag: string;
      commitSha: string;
      changedPaths: string[];
      author: CodexUser;
    }
  | {
      kind: 'vault.tag-deleted';
      tag: string;
      commitSha: string;
      changedPaths: string[];
      author: CodexUser;
    };

export interface EventAdapter {
  /** Receive a vault event. May be sync or async; sync coordinator awaits
   *  the promise before returning so hosts can keep their derived state
   *  consistent with the commit. If the host's emit() throws, the commit
   *  is NOT rolled back (it's already on disk + in git history) — the
   *  host is expected to retry / log / dead-letter on its own.
   */
  emit(event: VaultEvent): Promise<void> | void;
}

/** No-op adapter used when no host adapter is registered. */
export const noopEventAdapter: EventAdapter = { emit: () => undefined };
