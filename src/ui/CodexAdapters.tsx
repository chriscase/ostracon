'use client';

// AbydosCodex client-side adapters (chriscase/abydonian#231 + #232 + #230).
//
// Three adapter contracts exposed via a single React context, all defaulted
// to the Abydonian wiring so the host app keeps working with no changes.
// Extracted-codex consumers (or tests) wrap their tree in
// <CodexAdaptersProvider value={{ navigation, graphql, theme }}> to swap
// implementations without touching codex source.
//
// ─── NavigationAdapter (#231) ─────────────────────────────────────────
//
// Every codex component that uses next-intl's `Link` / `useRouter` reads
// them via `useCodexNavigation()` instead. The default implementation
// passes through to `@/i18n/navigation`; a non-i18n consumer can pass
// `next/link` + `next/navigation` directly.
//
// ─── GraphQLClientAdapter (#232) ──────────────────────────────────────
//
// `graphqlRequest()` is the only client-side IO the codex performs. The
// adapter is just a function-typed prop: `(query, variables) => Promise<{
// data?, errors? }>`. Hosts can hand in any client (Apollo, urql, raw
// fetch). Default wires `@/lib/graphql-client`.
//
// ─── CodexThemeProvider (#230) ────────────────────────────────────────
//
// Codex CSS uses CSS variables (--text-primary, --accent, --border, ...)
// inherited from whatever surrounds it; no Abydonian-specific imports
// today. The theme adapter is a forward-looking scaffold: hosts pass an
// optional set of icon overrides + a CSS-variable scope so that, when
// the codex moves to its own package, the public surface for visual
// customization is already in place.

import * as React from 'react';
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type AnchorHTMLAttributes,
} from 'react';
// React is imported above so the classic JSX transform (used by vitest in
// some test setups) can resolve `React.createElement`. We also import the
// named hooks because that's what the rest of the file uses.
void React;

// ─── Navigation ──────────────────────────────────────────────────────

export type NavigationLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children?: ReactNode;
};

export interface CodexRouter {
  push(href: string): void;
  replace(href: string): void;
}

export interface NavigationAdapter {
  Link: ComponentType<NavigationLinkProps>;
  useRouter(): CodexRouter;
}

// ─── GraphQL client ──────────────────────────────────────────────────

export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export type GraphQLRequestFn = <T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphQLResponse<T>>;

// ─── Theme ────────────────────────────────────────────────────────────

export interface CodexIcons {
  /** Tree disclosure icons (defaults to ▾ / ▸). */
  expanded?: ReactNode;
  collapsed?: ReactNode;
  /** Note row marker (defaults to · ; multi-selected is ✓). */
  noteMarker?: ReactNode;
  multiSelectedMarker?: ReactNode;
  /** Pinned star (defaults to none). */
  pin?: ReactNode;
}

export interface CodexTheme {
  icons?: CodexIcons;
  /** Optional CSS variable overrides applied to the root codex layout. */
  cssVars?: CSSProperties;
}

// ─── Combined context ────────────────────────────────────────────────

export interface CodexAdapters {
  navigation: NavigationAdapter;
  graphql: GraphQLRequestFn;
  theme: CodexTheme;
}

// ─── Inert defaults ──────────────────────────────────────────────────
//
// The default context value uses minimal stand-ins so the codex code
// loads without crashing even if a host forgets to wrap the tree. None
// of these are functional — a host that wants real behavior wraps
// children in <CodexAdaptersProvider> with its own values (Abydonian
// uses `CodexAdaptersAbydonianDefaults.tsx`).
//
// Important: this file MUST NOT import `@/i18n/navigation` or
// `@/lib/graphql-client` — the contract surface stays host-agnostic so
// the codex package can be extracted (Wave F) without rewiring.

const inertLink: ComponentType<NavigationLinkProps> = ({
  href,
  children,
  ...rest
}) =>
  createElement(
    'a',
    { href, ...(rest as Record<string, unknown>) },
    children,
  );

const inertRouter: CodexRouter = {
  push: (href: string) => {
    if (typeof window !== 'undefined') window.location.assign(href);
  },
  replace: (href: string) => {
    if (typeof window !== 'undefined') window.location.replace(href);
  },
};

const inertNavigation: NavigationAdapter = {
  Link: inertLink,
  useRouter: () => inertRouter,
};

const inertGraphqlRequest: GraphQLRequestFn = async () => {
  throw new Error(
    'Codex GraphQL request: no adapter wired. Wrap your codex tree in <CodexAdaptersProvider graphql={…}> or use the Abydonian defaults.',
  );
};

const defaultTheme: CodexTheme = {};

const DEFAULT_ADAPTERS: CodexAdapters = {
  navigation: inertNavigation,
  graphql: inertGraphqlRequest,
  theme: defaultTheme,
};

const CodexAdaptersContext = createContext<CodexAdapters>(DEFAULT_ADAPTERS);

interface ProviderProps {
  /** Override any subset of the adapters; unspecified fields fall back to
   *  the Abydonian default. */
  navigation?: NavigationAdapter;
  graphql?: GraphQLRequestFn;
  theme?: CodexTheme;
  children: ReactNode;
}

/**
 * Wrap codex components with overridden adapters. Tests + extracted-codex
 * consumers use this; the default Abydonian wiring is whatever the host
 * doesn't override.
 */
export function CodexAdaptersProvider({
  navigation,
  graphql,
  theme,
  children,
}: ProviderProps) {
  const value = useMemo<CodexAdapters>(
    () => ({
      navigation: navigation ?? DEFAULT_ADAPTERS.navigation,
      graphql: graphql ?? DEFAULT_ADAPTERS.graphql,
      theme: theme ?? DEFAULT_ADAPTERS.theme,
    }),
    [navigation, graphql, theme],
  );
  return (
    <CodexAdaptersContext.Provider value={value}>
      {children}
    </CodexAdaptersContext.Provider>
  );
}

// ─── Hooks ───────────────────────────────────────────────────────────

export function useCodexAdapters(): CodexAdapters {
  return useContext(CodexAdaptersContext);
}

export function useCodexNavigation(): NavigationAdapter {
  return useCodexAdapters().navigation;
}

export function useCodexGraphqlRequest(): GraphQLRequestFn {
  return useCodexAdapters().graphql;
}

export function useCodexTheme(): CodexTheme {
  return useCodexAdapters().theme;
}

/**
 * Plain function for code that needs the GraphQL client outside of a
 * component tree. Throws by default — hosts that want a module-level
 * client can re-export from their own wiring file.
 */
export const codexGraphqlRequest: GraphQLRequestFn = inertGraphqlRequest;
