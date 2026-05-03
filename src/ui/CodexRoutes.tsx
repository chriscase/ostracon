'use client';

// Plugin-style mountable-router surface (chriscase/abydonian#233).
//
// In the Next.js App Router, "mounting" a feature under a path prefix
// means the host writes its own page.tsx files under that prefix and
// renders the codex view inside. Ostracon doesn't own URLs — instead it
// exposes one component, `CodexRoute`, that picks a view based on a
// discriminated union, plus the standalone components (`CodexBrowser`,
// `CodexTagBrowser`) for hosts that want finer-grained mounting.
//
// Hosts mount it like this (Next.js App Router):
//
//   // app/admin/codex/page.tsx
//   'use client';
//   import { CodexRoute } from '@chriscase/ostracon/ui';
//   import { CodexAdaptersAbydonianProvider } from '@/components/codex/...';
//   export default function Page() {
//     return (
//       <CodexAdaptersAbydonianProvider>
//         <CodexRoute view={{ kind: 'welcome' }} />
//       </CodexAdaptersAbydonianProvider>
//     );
//   }
//
//   // app/admin/codex/note/[...path]/page.tsx
//   <CodexRoute view={{ kind: 'note', selectedPath, startInCreate }} />
//
// Hosts at /codex (no prefix) or /admin/codex (Abydonian) or /vault
// (someone else) all mount the same component — the URL prefix is
// purely the host's concern.

import { type ReactElement } from 'react';
import CodexBrowser, { type CodexView } from './CodexBrowser';
import CodexTagBrowser from './CodexTagBrowser';

export type CodexRouteSpec =
  | { kind: 'welcome' }
  | { kind: 'tree' }
  | { kind: 'graph'; scope?: string }
  | { kind: 'note'; selectedPath: string; startInCreate?: boolean }
  | { kind: 'tags' };

interface Props {
  view: CodexRouteSpec;
}

/**
 * One component, four routes. The host's page files just decide which
 * `kind` to render based on its routing — Ostracon doesn't care what URL
 * led here.
 *
 * Hosts that want to compose more freely (mix in a sidebar, render
 * multiple codex bits side-by-side, etc.) can import `CodexBrowser`,
 * `CodexTagBrowser`, etc. directly instead of going through this wrapper.
 */
export default function CodexRoute({ view }: Props): ReactElement {
  switch (view.kind) {
    case 'welcome':
      return <CodexBrowser view="welcome" />;
    case 'tree':
      // Browser handles "tree" implicitly via view !== 'graph' && !== 'note';
      // the welcome state is rendered when no path is selected. Pass
      // `welcome` explicitly so the type stays a single CodexView union.
      return <CodexBrowser view={'welcome' as CodexView} />;
    case 'graph':
      return <CodexBrowser view="graph" graphScope={view.scope} />;
    case 'note':
      return (
        <CodexBrowser
          view="note"
          selectedPath={view.selectedPath}
          startInCreate={view.startInCreate ?? false}
        />
      );
    case 'tags':
      return <CodexTagBrowser />;
  }
}
