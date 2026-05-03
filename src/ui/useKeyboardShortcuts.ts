'use client';

// Reusable keyboard-shortcut hook (chriscase/abydonian#219).
//
// Bindings are written as `mod+key` where `mod` resolves to `cmd` on Mac and
// `ctrl` everywhere else — matching the platform convention for "primary"
// modifiers. Multiple modifiers combine: `mod+shift+k`, `mod+alt+p`, etc.
//
// Shortcuts respect editable contexts: by default, an active <input>,
// <textarea>, contenteditable element, or any element inside a code editor
// suppresses the binding so typing into a search box doesn't trigger
// navigation. Set `allowInInputs: true` per binding to opt out (e.g., the
// editor's Cmd+S, which should fire even while typing).

import { useEffect, useReducer, useRef } from 'react';

export type ShortcutHandler = (event: KeyboardEvent) => void;

export type ShortcutMap = Record<string, ShortcutHandler | ShortcutBinding>;

export interface ShortcutBinding {
  handler: ShortcutHandler;
  /** When true, the shortcut still fires inside text inputs. Default false. */
  allowInInputs?: boolean;
}

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPod|iPad/i.test(navigator.platform);

/**
 * Resolve a shortcut combo string (e.g. `mod+shift+k`) into the canonical
 * lowercase representation we match against in the keydown handler.
 *
 * "mod" maps to "cmd" on Mac and "ctrl" elsewhere.
 */
export function normalizeCombo(raw: string): string {
  const parts = raw
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  let key = '';
  for (const part of parts) {
    if (part === 'mod') {
      mods.push(isMac ? 'cmd' : 'ctrl');
    } else if (part === 'cmd' || part === 'meta') {
      mods.push('cmd');
    } else if (part === 'ctrl' || part === 'control') {
      mods.push('ctrl');
    } else if (part === 'shift') {
      mods.push('shift');
    } else if (part === 'alt' || part === 'option') {
      mods.push('alt');
    } else {
      key = part;
    }
  }
  // Order modifiers consistently for matching
  const modOrder = ['cmd', 'ctrl', 'alt', 'shift'];
  mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));
  return [...mods, key].join('+');
}

function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('cmd');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key.toLowerCase();
  if (key === 'escape') key = 'esc';
  parts.push(key);
  return parts.join('+');
}

function shouldSuppressForTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.dataset.allowText === 'true') return true;
  // CodeMirror (used by react-md-editor) creates contenteditable divs deep
  // inside .cm-editor. Walk up looking for the editor wrapper.
  if (target.closest('.cm-editor, .w-md-editor, .CodeMirror')) return true;
  return false;
}

/**
 * Register a map of keyboard shortcuts on `window`. The map is stored in a
 * ref so the listener doesn't re-attach on every render — handlers can read
 * fresh state via closures created on each render without thrashing the
 * window listener.
 */
export function useShortcuts(shortcuts: ShortcutMap): void {
  const ref = useRef<ShortcutMap>(shortcuts);
  ref.current = shortcuts;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const combo = eventToCombo(e);
      for (const [pattern, value] of Object.entries(ref.current)) {
        const normalized = normalizeCombo(pattern);
        if (combo !== normalized) continue;
        const binding: ShortcutBinding =
          typeof value === 'function' ? { handler: value } : value;
        if (!binding.allowInInputs && shouldSuppressForTarget(e.target)) {
          continue;
        }
        binding.handler(e);
        // Stop after the first match to avoid duplicate handlers competing.
        break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

// ─── Help-dialog metadata ────────────────────────────────────────────────
//
// Components that register shortcuts can also register a HELP entry (label +
// combo) so the Cmd+? dialog can list them in one place. This is a tiny
// in-memory registry — no global state library, just a Map keyed by combo.

export interface ShortcutHelpEntry {
  combo: string;
  label: string;
  category?: string;
}

const helpRegistry = new Map<string, ShortcutHelpEntry>();
const helpListeners = new Set<() => void>();

function notifyHelpListeners(): void {
  helpListeners.forEach((fn) => fn());
}

export function registerShortcutHelp(entries: ShortcutHelpEntry[]): () => void {
  for (const entry of entries) {
    helpRegistry.set(normalizeCombo(entry.combo), entry);
  }
  notifyHelpListeners();
  return () => {
    for (const entry of entries) {
      helpRegistry.delete(normalizeCombo(entry.combo));
    }
    notifyHelpListeners();
  };
}

export function useShortcutHelp(): ShortcutHelpEntry[] {
  // Re-render when the registry changes by subscribing to the listener set.
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    helpListeners.add(force);
    return () => {
      helpListeners.delete(force);
    };
  }, [force]);
  const entries = [...helpRegistry.values()];
  entries.sort((a, b) => {
    const cat = (a.category ?? '').localeCompare(b.category ?? '');
    if (cat !== 0) return cat;
    return a.label.localeCompare(b.label);
  });
  return entries;
}

/** Format a normalized combo for display (e.g. "cmd+k" → "⌘K", "ctrl+k" → "Ctrl+K"). */
export function formatCombo(combo: string): string {
  const norm = normalizeCombo(combo);
  return norm
    .split('+')
    .map((p) => {
      switch (p) {
        case 'cmd':
          return isMac ? '⌘' : 'Cmd';
        case 'ctrl':
          return isMac ? '⌃' : 'Ctrl';
        case 'alt':
          return isMac ? '⌥' : 'Alt';
        case 'shift':
          return isMac ? '⇧' : 'Shift';
        case 'esc':
          return 'Esc';
        case 'enter':
          return '↵';
        default:
          return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
      }
    })
    .join(isMac ? '' : '+');
}

export { isMac };
