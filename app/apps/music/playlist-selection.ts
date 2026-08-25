export type PlaylistSelectionItem = {
  id: string;
  title: string;
  subtitle?: string;
  active: boolean;
};

export type PlayingTrackIdentity = {
  title: string;
  artist: string;
};

export type PlaylistSelection = {
  index: number;
  /**
   * Android MediaSession queue IDs are signed 64-bit values. Keep the ID as
   * text so JavaScript never rounds a value outside Number.MAX_SAFE_INTEGER.
   */
  itemId: string | null;
};

function canonicalMediaText(value: string | undefined): string {
  const text = String(value ?? "");
  try {
    return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  } catch {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
  }
}

/**
 * Resolve the current playback item without assuming the Android player
 * publishes PlaybackState.activeQueueItemId. Several otherwise complete media
 * sessions leave that ID unknown while exposing matching queue metadata.
 */
export function resolvePlayingQueueIndex(
  queue: PlaylistSelectionItem[],
  playing: PlayingTrackIdentity,
  fallbackIndex = 0,
): number {
  if (!queue.length) return 0;

  const activeIndex = queue.findIndex((item) => item.active);
  if (activeIndex >= 0) return activeIndex;

  const playingTitle = canonicalMediaText(playing.title);
  if (playingTitle) {
    const titleMatches: number[] = [];
    for (let index = 0; index < queue.length; index++) {
      if (canonicalMediaText(queue[index]!.title) === playingTitle) {
        titleMatches.push(index);
      }
    }

    const playingArtist = canonicalMediaText(playing.artist);
    if (playingArtist) {
      const titleAndArtist = titleMatches.find(
        (index) => canonicalMediaText(queue[index]!.subtitle) === playingArtist,
      );
      if (titleAndArtist !== undefined) return titleAndArtist;
    }
    if (titleMatches.length) return titleMatches[0]!;
  }

  return Math.max(0, Math.min(queue.length - 1, Math.trunc(fallbackIndex)));
}

/**
 * Capture an index and, when the player supplied a usable unique queue ID, a
 * stable identity for that row. UNKNOWN_ID (-1) and duplicate IDs cannot
 * safely identify an item across a reordered queue.
 */
export function selectPlaylistIndex(
  queue: PlaylistSelectionItem[],
  requestedIndex: number,
): PlaylistSelection {
  if (!queue.length) return { index: 0, itemId: null };
  const index = Math.max(0, Math.min(queue.length - 1, Math.trunc(requestedIndex)));
  return { index, itemId: uniqueQueueItemId(queue, index) };
}

/**
 * Follow the selected item when an asynchronous media-session callback
 * reorders the queue. If the selected ID is temporarily absent, retain it and
 * keep a bounded visual index so the next callback can recover the same row.
 */
export function reconcilePlaylistSelection(
  queue: PlaylistSelectionItem[],
  selection: PlaylistSelection,
): PlaylistSelection {
  if (!queue.length) {
    return { index: 0, itemId: selection.itemId };
  }

  if (selection.itemId !== null) {
    const matchingIndexes: number[] = [];
    for (let index = 0; index < queue.length; index++) {
      if (queue[index]!.id === selection.itemId) matchingIndexes.push(index);
    }
    if (matchingIndexes.length === 1) {
      return { index: matchingIndexes[0]!, itemId: selection.itemId };
    }

    // Do not replace a temporarily missing stable ID with whichever row now
    // occupies its old index. A later queue callback may restore that item.
    return {
      index: Math.max(0, Math.min(queue.length - 1, Math.trunc(selection.index))),
      itemId: selection.itemId,
    };
  }

  return selectPlaylistIndex(queue, selection.index);
}

function uniqueQueueItemId(queue: PlaylistSelectionItem[], index: number): string | null {
  const id = queue[index]?.id?.trim() ?? "";
  if (!id || id === "-1") return null;
  let matches = 0;
  for (const item of queue) {
    if (item.id === id) matches++;
    if (matches > 1) return null;
  }
  return id;
}
