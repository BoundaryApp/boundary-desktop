/**
 * What's new, as the renderer sees it (ADR 0059): main says what this launch is and what has
 * been read, the bundled content says what there is to read, and this works out what to show.
 *
 * Releases are ordered newest first, so "between two versions" is a slice. The renderer needs no
 * version compare of its own.
 */
import { useSyncExternalStore } from 'react';
import type { Release } from '../../../shared/types/releaseNotes';
import type { WhatsNewSnapshot } from '../../../shared/types/whatsNew';
import { loadReleases } from './content';

export interface WhatsNewView {
  /** The release running now, when it has notes. */
  current: Release | null;
  /** Releases skipped between the version upgraded from and this one, newest first. */
  missed: Release[];
  /** Something here hasn't been read: the rail shows a dot. */
  unseen: boolean;
  /** This release is new to this install and hasn't been read. */
  unread(version: string): boolean;
  popups: boolean;
  /** This launch should open the notes by itself. */
  pendingPopup: boolean;
  /** Every bundled release, newest first. */
  releases: Release[];
  markSeen(version: string): void;
  setPopups(on: boolean): void;
}

let snapshot: WhatsNewSnapshot | null = null;
let view: WhatsNewView | null = null;
let loading = false;
let stopListening: (() => void) | null = null;
const listeners = new Set<() => void>();

function api() {
  return window.electronAPI?.whatsNew;
}

function derive(state: WhatsNewSnapshot): WhatsNewView {
  const releases = loadReleases();
  const index = (version: string | null) =>
    version === null ? -1 : releases.findIndex((release) => release.version === version);
  const currentAt = index(state.currentVersion);
  const current = currentAt >= 0 ? releases[currentAt] : null;
  const fromAt = index(state.upgradedFrom);
  // Releases this install never ran: between the one it came from and the one running now. An
  // install whose earlier version isn't bundled, or isn't known, catches up on this one only.
  const floor = fromAt > currentAt ? fromAt : currentAt + 1;
  const unread = (version: string): boolean => {
    const at = index(version);
    if (at < currentAt || at >= floor || state.seen.includes(version)) return false;
    // A release that shipped without notes has nothing to read, so it marks nothing.
    return releases[at].slides.length > 0;
  };
  const missed = currentAt >= 0 ? releases.slice(currentAt + 1, floor) : [];
  return {
    current,
    missed,
    unread,
    unseen: releases.some((release) => unread(release.version)),
    popups: state.popups,
    pendingPopup:
      state.popups && current !== null && unread(current.version) && state.upgradedFrom !== null,
    releases,
    markSeen: (version) => {
      void api()?.markSeen(version);
      if (snapshot && !snapshot.seen.includes(version)) {
        publish({ ...snapshot, seen: [...snapshot.seen, version] });
      }
    },
    setPopups: (on) => {
      void api()?.setPopups(on);
      if (snapshot) publish({ ...snapshot, popups: on });
    },
  };
}

function publish(next: WhatsNewSnapshot): void {
  snapshot = next;
  view = derive(next);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loading) {
    loading = true;
    // Another window's change reaches this one through main.
    stopListening = api()?.onState(publish) ?? null;
    void api()
      ?.getState()
      .then((state) => {
        if (state && !snapshot) publish(state);
      });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
      loading = false;
    }
  };
}

/** The release notes state, or null until main has answered. */
export function useWhatsNew(): WhatsNewView | null {
  return useSyncExternalStore(
    subscribe,
    () => view,
    (): WhatsNewView | null => null
  );
}

export function resetWhatsNewForTests(): void {
  snapshot = null;
  view = null;
  loading = false;
  stopListening = null;
  listeners.clear();
}
