# Contributing to Ostracon

## Getting started

```bash
git clone https://github.com/chriscase/ostracon.git
cd ostracon
npm install
npm test
npm run type-check
```

The test suite uses real `git` operations against ephemeral repos in `/tmp` — make sure you have `git` installed (any recent version is fine).

## Code conventions

- TypeScript everywhere, strict mode on
- Tests via Vitest; aim for 90%+ coverage on new lib code
- Adapter contracts (`AuthAdapter`, `NavigationAdapter`, etc.) require contract tests demonstrating any new implementation passes the same suite
- React components are functional, use hooks, no class components
- CSS modules (`*.module.css`) for component styling — no global CSS in the package

## Architecture rules

- **Server (`src/server/`)**: Node-only — uses `node:fs`, `simple-git`, `@prisma/client` (peer dep). Never imports React.
- **Server browser-safe (`src/server/client.ts`)**: pure modules safe for client bundling — frontmatter, wikilinks, auto-managed-paths, type-only auth-adapter. Used by UI components that need just types or pure helpers.
- **UI (`src/ui/`)**: React components. Imports server only via `/server/client`. Never imports `node:*` or `simple-git`.
- **Adapters before direct imports**: any host-specific dependency goes through an adapter (auth, navigation, GraphQL client, theme). Never import `next/link`, `next-intl`, or your favorite GraphQL client directly.

## PRs

- Branch from `main`
- One logical change per PR
- Tests + typecheck + lint must pass (CI enforces)
- Squash-merge preferred for cleanliness; commit message follows the body of the PR description
- Reference the issue you're closing in the PR body (`Closes #N`)

## Filing issues

- Bug reports: include reproduction steps, expected vs actual, version
- Feature requests: explain the use case before the proposed implementation
- Security issues: see `SECURITY.md` (do NOT file as a public issue)

## Release process

- v0.x.y → v0.x.(y+1): bug fixes, no contract changes
- v0.x.y → v0.(x+1).0: new features, possibly minor contract additions
- v0.x.y → v1.0.0: stable adapter contracts, full SemVer commitments

Tag the release in the repo (`git tag v0.1.0 && git push --tags`); consumers pin via `github:chriscase/ostracon#v0.1.0`. No npm publish until/unless adoption pressure makes it worthwhile.
