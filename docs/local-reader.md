# Local reader and teleprompter

Hermes G2 includes an offline reader for plain UTF-8 text and Markdown. Markdown is displayed as inert text: Hermes does not execute HTML or scripts, fetch remote URLs, load embedded media, or upload document content.

## Import a document

1. On the phone's **Glasses** tab, choose **Open local document** (the visible button or action-bar menu).
2. Android's system document picker opens. Choose one `.txt`, `.md`, or other provider item with a plain-text/Markdown MIME type.
3. Android grants Hermes read access to that one URI. Hermes does not request a directory grant or add filesystem permissions for this workflow.

Imports are strict UTF-8 and bounded to 512 KB at the Android stream boundary and 200,000 Unicode code points in the pure layout boundary. Missing, revoked, wrong-type, malformed, and oversized documents fail closed without opening a reader window.

## On-glasses controls

- Ring or arm scroll: previous/next page.
- Click: start or pause auto-scroll.
- Long press: open the window menu. It contains auto-scroll start/pause and speed, small/medium/large font, compact/normal/wide line spacing, set/jump bookmark, and the standard close action.
- Double-click: yield to the shell sidebar.

Auto-scroll runs only while the exact reader window owns the foreground and the G2 screen is on. Background, screen-off, end-of-document, replacement, and close synchronously cancel its one timer; stale callbacks are generation-rejected.

## Local state and privacy

For a document chosen through Android's picker, Hermes stores only the user-approved `content://` URI plus page, bookmark, typography, and speed metadata. It does not persist the document body or expose the filename as the shell/assistant window title. Reopening the same URI restores progress in a paused state. Closing immediately cancels work and releases the in-memory text and rendered surface ownership.

Shared text and legacy Files-browser paths can also open the reader, but do not persist a URI or resume metadata. Android backup remains disabled; uninstall or app-data clear removes reader metadata and URI access.
