# Conversate: local-first conversation assistance

Hermes G2's **Conversate** app replaces the former Transcribe launcher surface.
It provides an explicit, volatile conversation session with live transcription,
optional Soniox translation, and locally derived action/question/topic cues on
the bounded monochrome display. It is inspired by the interaction shape of Even
Conversate but does not depend on the Even cloud service.

## Lens controls

- Opening **Conversate** does not start the microphone.
- On the preflight screen, scroll to choose between on-device transcription and
  cloud providers whose credentials are already configured; click starts.
- During a session, scroll through local cues and click for cue detail. The
  window menu also provides pause/resume and end actions.
- Pausing flushes the exact provider generation before releasing it, so final
  words are retained. Resume receives a fresh capture generation.
- Double-click ends an open session. From preflight or review it yields to the
  shell's normal sidebar navigation.
- Backgrounding, screen-off, voice-UI microphone handoff, or close cancels
  immediately; stale provider callbacks cannot resurrect the session.
- Review shows bounded in-memory counts, latest text, and cue totals. Starting a
  new session or closing the window clears it.

Every important state is textual on-lens: ready, starting, listening, paused,
finishing, network/provider error, and complete. Cues are explicitly labelled as
local heuristics, not externally verified facts.

## Phone settings

Settings → **Conversate & captions** exposes bounded controls for:

- an app-owned transcription provider independent from assistant dictation;
- source language hint and optional Soniox translation target;
- source-only, source/translation split, or translation-first layout;
- font size, line spacing, and maximum lines;
- provider-evidenced speaker labels;
- bounded custom vocabulary.

Bundled on-device Moonshine is always available and is the default. A cloud
provider is selectable only after its Keystore-backed credential is configured.
Translation is available only when Soniox is selected. Custom vocabulary stays
phone-local because none of the currently integrated providers advertises a
verified vocabulary contract.

## Provider-neutral lifecycle

Each transcript event carries the complete current source text (replace
semantics), finality, monotonic capture generation, receive time, and optional
provider evidence such as language, confidence, speaker, and translation.
Hermes never invents missing metadata.

The framework-free reducers retain at most 128 recent conversation utterances
and 32,768 Unicode scalar values in RAM. Long words wrap on grapheme boundaries;
newest captions grow upward from a stable bottom row. Source text remains visible
when translation is empty, late, failed, or unsupported.

Permission continuations, Java callbacks, cloud callbacks, PCM delivery,
provider swaps, screen-off, backgrounding, pause, close, and cancellation are
generation-bound. Pause/end use a bounded provider-final flush. Exact cloud
client identity is checked as well as generation.

## Privacy

Source and translation text remain memory-only. Hermes does not write a
Conversate transcript to Downloads or persistence. Conversate never enables the
developer voice-recording path, even if that separate assistant diagnostic
switch is on.

On-device transcription keeps audio on the phone. Explicitly selecting a cloud
provider sends microphone audio to that provider under its terms. Soniox
translation runs in that same selected stream. API keys are Android
Keystore-backed and never sent to the glasses or included in transcript events,
logs, screenshots, fixtures, or repository artifacts. The wearer is responsible
for informing participants and complying with applicable recording laws.

## Limitations and evidence

- Local cues classify captured words only. They do not search the web, identify
  people, or fabricate factual answers.
- The bitmap renderer does not provide complete Unicode shaping or bidirectional
  layout. Grapheme-safe wrapping prevents broken scalar sequences, but full
  Arabic shaping and RTL ordering are not claimed.
- A build proves compilation, not microphone, provider-network, transport, or
  optical readability. Hardware acceptance separately covers install/launch,
  live microphone text, pause/end flush, screen/background teardown, and a
  privacy-safe log review.
