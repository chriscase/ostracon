// Browser-safe public surface for `@chriscase/ostracon/server`.
//
// The main entry point (`./index.ts`) re-exports the full server runtime,
// including modules that import `node:fs/promises` / `node:os` (sync,
// fs, config, git). Those modules can't be bundled for the browser.
//
// This `/client` subpath exposes ONLY the modules that are pure / browser-
// safe — `frontmatter`, `wikilinks`, `auto-managed`, `secrets`, the
// `auth-adapter` contract types, and the `find-replace` / `user-prefs`
// type-only surfaces.
//
// React components (in @chriscase/ostracon/ui) that need parseNote/
// serializeNote/Frontmatter import from `@chriscase/ostracon/server/client`
// to keep the client bundle slim and avoid webpack errors about
// `node:fs/promises` being unhandled.

export * from './frontmatter';
export * from './wikilinks';
export * from './auto-managed';
export {
  type CodexPermission,
  type CodexUser,
  type AuthAdapter,
} from './auth-adapter';
