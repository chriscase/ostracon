// Standardized commit-message format for vault edits.
//
// Goals:
//   • Subject lines stay scannable in `git log --oneline` (≤ 72 chars).
//   • Trailers follow the git convention (parseable by
//     `git interpret-trailers --parse`) so downstream tooling — audit
//     log, search-index sync, MCP audit — can reliably extract the
//     note path and uuid from any commit.
//   • Body is the user's free-text reason (optional). When absent, the
//     subject + trailers stand alone.
//
// Example output:
//
//   edit: NexaDeck.md via HallOfRecords v1
//
//   Clarified the distinction between peng-as-quality and peng-as-direction.
//
//   Note-Path: 20 - Products/NexaDeck.md
//   Note-UUID: 0190f3b5-2c3a-7f4a-8a6c-9d3e1f5a4b62
//   Edited-Via: HallOfRecords v1
//
// The buildCodexCommitMessage helper produces this consistently. Hosts
// can build messages themselves and pass them via opts.commitMessage; if
// they don't, the resolvers in @chriscase/ostracon/graphql call this
// helper with the same input.

export type CodexCommitVerb =
  | 'edit'
  | 'create'
  | 'rename'
  | 'move'
  | 'delete'
  | 'create-folder'
  | 'rename-folder'
  | 'delete-folder'
  | 'move-folder'
  | 'revert'
  | 'find-replace'
  | 'rename-tag'
  | 'delete-tag';

export interface CodexCommitInput {
  verb: CodexCommitVerb;
  /** Primary subject — note path, folder path, or tag name. */
  path: string;
  /** For rename / move ops: the destination path. */
  newPath?: string;
  /** For revert: the SHA the note is being reverted to. */
  toSha?: string;
  /** Stable UUID of the affected note, when known. Omitted from the
   *  trailers when absent (e.g., during the brief pre-backfill window
   *  on existing vaults, or for folder-level ops). */
  uuid?: string | null;
  /** Optional user-provided reason — becomes the commit body. */
  userMessage?: string;
  /** Host tag (e.g., "HallOfRecords v1", "Abydonian admin"). Used in
   *  the subject + the `Edited-Via:` trailer. Defaults to "Ostracon"
   *  when omitted. */
  editedVia?: string;
}

const SUBJECT_LIMIT = 72;

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function buildSubject(input: CodexCommitInput): string {
  const via = input.editedVia ?? 'Ostracon';
  const suffix = ` via ${via}`;

  function fit(body: string): string {
    const subject = `${body}${suffix}`;
    if (subject.length <= SUBJECT_LIMIT) return subject;
    // Truncate just the body (keep verb + " via X" intact).
    const room = SUBJECT_LIMIT - suffix.length;
    if (room <= 4) return subject; // suffix already too long; give up gracefully
    return `${body.slice(0, room - 1).trimEnd()}…${suffix}`;
  }

  switch (input.verb) {
    case 'edit':
    case 'create':
    case 'delete':
    case 'create-folder':
    case 'delete-folder':
      return fit(`${input.verb}: ${basename(input.path)}`);
    case 'rename':
    case 'move':
    case 'rename-folder':
    case 'move-folder':
      return fit(
        `${input.verb}: ${basename(input.path)} → ${basename(input.newPath ?? '')}`,
      );
    case 'revert':
      return fit(
        `revert: ${basename(input.path)} to ${(input.toSha ?? '').slice(0, 7)}`,
      );
    case 'find-replace':
      return fit(`find-replace: ${input.path}`);
    case 'rename-tag':
      return fit(`rename-tag: ${input.path} → ${input.newPath ?? ''}`);
    case 'delete-tag':
      return fit(`delete-tag: ${input.path}`);
  }
}

function buildTrailers(input: CodexCommitInput): string[] {
  const via = input.editedVia ?? 'Ostracon';
  const lines: string[] = [];

  // Folder / tag ops don't anchor to a single note UUID — use the
  // appropriate trailer key for clarity.
  switch (input.verb) {
    case 'create-folder':
    case 'rename-folder':
    case 'delete-folder':
    case 'move-folder':
      lines.push(`Folder-Path: ${input.path}`);
      if (input.newPath) lines.push(`Folder-New-Path: ${input.newPath}`);
      break;
    case 'rename-tag':
    case 'delete-tag':
      lines.push(`Tag: ${input.path}`);
      if (input.newPath) lines.push(`Tag-New: ${input.newPath}`);
      break;
    case 'find-replace':
      // No anchor path; the apply outcome already lists changed files.
      break;
    default:
      lines.push(`Note-Path: ${input.path}`);
      if (input.newPath) lines.push(`Note-New-Path: ${input.newPath}`);
      if (input.uuid) lines.push(`Note-UUID: ${input.uuid}`);
      if (input.verb === 'revert' && input.toSha) {
        lines.push(`Revert-To-SHA: ${input.toSha}`);
      }
      break;
  }

  lines.push(`Edited-Via: ${via}`);
  return lines;
}

/**
 * Build a standardized commit message for a codex mutation. Hosts can
 * call this directly when they want a particular format upfront;
 * Ostracon's mutation resolvers call it as a fallback when the caller
 * doesn't supply a custom commitMessage.
 *
 * The output is git-trailer compatible — every machine-readable field
 * after the first blank line passes `git interpret-trailers --parse`.
 */
export function buildCodexCommitMessage(input: CodexCommitInput): string {
  const subject = buildSubject(input);
  const trailers = buildTrailers(input);
  const userBody = input.userMessage?.trim();

  // Format: <subject>\n\n[<userBody>\n\n]<trailers...>
  const sections: string[] = [subject];
  if (userBody) sections.push(userBody);
  sections.push(trailers.join('\n'));
  return sections.join('\n\n');
}
