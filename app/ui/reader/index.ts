/** Shared bounded reader primitives used by local and remote long-content surfaces. */

export * from "../../apps/files/reader-core";

export type ReaderOwner =
  | "notification"
  | "cockpit"
  | "context-dashboard"
  | "file"
  | "capture"
  | "other";

export type LongReaderSource = {
  owner: ReaderOwner;
  documentId: string;
  revision: string;
  title: string;
  text: string;
  /** Return false when the owner has been removed or replaced. */
  isCurrent?: () => boolean;
};

export function readerSourceId(source: Pick<LongReaderSource, "owner" | "documentId" | "revision">): string {
  return `${source.owner}:${source.documentId}:${source.revision}`;
}
