# Accessibility-first live captions

Hermes G2's Captions app provides volatile, foreground-owned source captions and optional Soniox translation on the 576×288 monochrome display.

## Lens controls

- Open **Captions** from the launcher. The microphone starts only when the Captions window is foreground and the glasses screen is on.
- Click pauses or resumes. Pausing invalidates the current capture generation before stopping it, so late provider tokens cannot reappear.
- Scroll up/down reads older/newer wrapped lines. New text remains bottom-anchored in live-follow mode.
- Long-press opens app actions for pause/resume, immediate clear, voice input, and close.
- Double-click yields to the shell sidebar. Selecting another window stops caption capture immediately; returning starts a fresh generation.
- Closing clears all in-memory source/translation text and stops audio/network work.

Every important state is textual on-lens: `[STARTING]`, `[LIVE]`, `[PAUSED]`, `[STOPPED]`, `[MIC ERROR]`, `[NETWORK]`, `[PROVIDER ERROR]`, `[TR WAIT]`, stale-event drops, and bounded audio-frame drops. Captions do not rely on a tone or icon alone.

## Phone settings

Settings → **Live captions & translation** exposes bounded controls for:

- source language hint and target language;
- source-only, source/translation split, or translation-first layout;
- small/medium/large font, line spacing, and maximum lines;
- provider-evidenced speaker labels;
- bounded custom vocabulary.

Translation is available only when Soniox is the selected transcription provider and a Soniox key is configured in the existing Keystore-backed, replace-only API-key screen. `Translate to: off` works with on-device transcription and no translation credential. Custom vocabulary remains phone-local because none of the currently integrated providers advertises a verified vocabulary contract; the UI states that it is not sent.

## Provider-neutral event and lifecycle contract

Each transcript event carries the complete current best source text (replace semantics), finality, monotonic capture generation, receive time, and optional language, confidence, provider speaker evidence, translation text/finality/target, and aggregate dropped-audio count. Metadata stays absent when the provider supplies no evidence; Hermes does not invent confidence, language, speaker, or translation text.

The caption reducer is framework-free and bounded to 256 finalized segments / 32,768 code points. Long words wrap on grapheme boundaries. Newest lines grow upward from a stable bottom row. Source captions remain readable while translation is empty, late, failed, or unsupported.

Permission continuations, Java callbacks, cloud callbacks, PCM delivery, provider swaps, screen-off, backgrounding, pause, close, and cancellation are generation-bound. Exact cloud-client identity is checked in addition to generation. Soniox reconnects with bounded exponential backoff, retains at most 50 pending PCM chunks, drops oldest audio beyond that bound, and exposes only an aggregate drop count.

## Privacy

Caption source and translation text remain memory-only. Hermes does not write a transcript to Downloads and does not persist caption content. The developer-only **Save voice recordings** setting is separate, defaults off, and should remain off for ordinary caption use.

On-device transcription keeps audio on the phone. Selecting a cloud transcription provider sends microphone audio to that provider under its terms. Soniox translation is performed in the same selected Soniox stream. API keys use Android Keystore-backed replace-only storage and are never sent to the glasses or included in caption events, logs, screenshots, fixtures, or PR artifacts.

## Limitations and honest evidence

- The bundled bitmap fonts and renderer do not provide complete Unicode shaping or bidirectional layout. Grapheme-safe wrapping prevents broken surrogate/combining sequences, but Arabic shaping, robust RTL ordering, CJK and emoji glyph coverage are not claimed; phone-selectable languages are limited to supported Latin-script choices.
- Provider custom-vocabulary transport is disabled until an exact supported API contract is implemented and tested.
- Automated fixtures exercise partial rewrites, stale generations, bounds, Unicode graphemes, long words, speaker evidence, translation lag, lifecycle hooks, and local/cloud disclosure. They use synthetic text only.
- A build proves compilation, not microphone, network, transport, or optical readability. Hardware evidence must separately name install/launch, G2 session, scripted fixture/live microphone result, stop/clear/background behavior, and privacy-safe log review.
