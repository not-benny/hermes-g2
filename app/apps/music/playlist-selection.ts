export type PlaylistSelectionItem = {
  title: string;
  subtitle?: string;
  active: boolean;
};

export type PlayingTrackIdentity = {
  title: string;
  artist: string;
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
