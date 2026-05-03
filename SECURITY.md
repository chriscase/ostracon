# Security policy

## Reporting

Please report security issues by emailing **cc@chriscase.cc** with a subject line that begins with `[Ostracon Security]`. Don't file public GitHub issues for vulnerabilities.

## Threat model

Ostracon is a vault editor that runs server-side git operations and serves binary attachments. The most important boundaries:

| Boundary | Defense |
|---|---|
| Path traversal in vault file ops | Every file path goes through `resolveVaultPath()` which rejects absolute paths, null bytes, and paths that resolve outside the vault root. Tests in `src/server/lib/__tests__/fs.test.ts` enforce this. |
| Secret leakage via vault content | Every `saveNote` / `revertNote` / `applyVaultReplacement` runs `scanContent()` against a configurable rule set before committing. Refused content gets returned as `{ kind: 'SECRETS', hits }` so the UI can surface what was rejected. |
| Auth bypass | The codex never authenticates requests itself — it requires every host to wire an `AuthAdapter`. The default fallback throws a clear error if nothing is wired. |
| Symlink attacks in the vault | `readVaultFile` / `readVaultBinary` call `fs.realpath` and re-check the resolved path is still inside the vault root. |
| Webhook spoofing | The optional GitHub webhook handler verifies HMAC-SHA-256 against the `CODEX_WEBHOOK_SECRET` env var. Configure both ends to match. |
| Attachment upload XSS | The blob route serves attachments with `X-Content-Type-Options: nosniff` and a per-extension Content-Type. SVG uploads are allowed by default but the host can override `ABYDOS_ALLOWED_ATTACHMENT_EXTS` to drop them if SVG-as-XSS is a concern in their threat model. |

## What's in scope

- The codex code in `src/`
- The `AuthAdapter` contract surface (we'll fix anything that lets a vault op skip auth)
- The path-traversal guards
- The secret-scanning surface

## Out of scope

- Bugs in your `AuthAdapter` implementation — we can't audit your auth system
- Vulnerabilities in `simple-git`, `gray-matter`, `react`, `next` — please report those upstream
- Vulnerabilities in your own host wiring code

## Response

We aim to acknowledge within 7 days and ship a fix or mitigation within 30 days for high-severity issues. Lower-severity issues land in the next regular release.
