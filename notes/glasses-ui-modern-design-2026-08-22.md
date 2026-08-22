# Modern design solutions for the Hermes G2 glasses UI (2026-08-22)

## Decision

Hermes G2 should pursue a **quiet, glance-first, grayscale-native design
language**, not a miniature phone UI or an animated AR dashboard. The strongest
practical model is:

1. a stable ambient shell with very little persistent information;
2. replace-only glance cards for interruptions and status;
3. short linear lists with progressive disclosure;
4. explicit, confirmable action sheets;
5. reviewed voice input for text entry; and
6. phone handoff for complex configuration, authentication, or long-form work.

This direction modernizes the interface through hierarchy, restraint, clear
state, and predictable motion rather than gradients, translucency, dense
widgets, or freeform spatial UI. It fits the current renderer and four-gesture
input model and is the best current hypothesis for reducing competition with
the real world while leaving room for accessibility and transport reliability;
those human outcomes still require real-G2 validation.

This investigation is documentation only. It does not redesign or implement the
UI, change display constraints, claim optical performance, or authorize
hardware, pairing, firmware, or destructive operations.

## Evidence boundaries

The repository facts below were inspected at commit
`b7db32e2d280dcde301551a3863a064f777e5f55`. External source URLs were checked on
2026-08-22: 12 opened in the automated check, while the Gabbard, van der Burg,
and Denning DOI publisher endpoints denied automated retrieval with HTTP 403.
Those three are cited by DOI but were not re-read in this run. Product guidance
from Google Glass and Microsoft Mixed Reality is precedent, not a standard for
the G2. WCAG and W3C XR guidance are useful accessibility baselines, not proof
of optical see-through legibility. Published studies used different hardware,
tasks, and populations; their findings justify conservative design choices but
do not replace real-G2 testing.

No optical contrast, angular character size, field of view, refresh rate,
gesture error rate, walking performance, comfort, or dominant-eye effect was
measured in this investigation. Pixel dimensions and framebuffer contrast do
not establish perceived size or contrast at the eye.

## Current G2 constraints and interaction model

### Display and rendering

- The logical lens canvas is **640 x 480** (`app/graphics/image.ts:4-5`).
- TypeScript draws into custom `GrayImage` buffers using BDF fonts and raster
  primitives, not a DOM or generic widget toolkit
  (`app/graphics/image.ts:24-135`).
- Text drawing advances one code point at a time with available BDF glyphs;
  no bidirectional or complex-script shaping contract was identified
  (`app/graphics/image.ts:108-121`). Robust RTL and complex-script support would
  require layout/font work, not merely broader test strings.
- Retained surfaces are 8-bit grayscale, but the wire pipeline quantizes them to
  **4 bpp**, so only 16 output levels remain and the low nibble is not visible
  (`App_Resources/Android/src/main/java/com/faceclaw/app/SurfaceCompositor.java:23-29`).
- Pixel zero is the transparent key on keyed shell surfaces; intentional black
  uses value one (`app/ui/shell/geometry.ts:16-21`). Designs must not depend on
  subtle adjacent shades.
- The standard shell reserves a **72 px sidebar** and **28 px top bar**. A
  standard window occupies a 288 px-high band, leaving a **568 x 260** app
  viewport; a full-height window has a **568 x 452** viewport
  (`app/ui/shell/geometry.ts:4-15,23-34,70-75`). The standard band can be moved
  vertically by the wearer (`app/ui/shell/geometry.ts:36-53`).
- Delta transport aligns changed rectangles to four horizontal pixels and two
  rows. Full-screen changes fall back to a full update, while separated local
  edits may use multiple rectangles
  (`App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/BleImageOptimizer.java:192-205,236-243`).
  Therefore stable screens and localized changes are a much better fit than
  full-screen fades, texture, parallax, or continuously moving dashboards.
- Existing animation precedent is modest: list-edge feedback moves six pixels
  over 220 ms and repaints every 24 ms (`app/ui/edge-scroll.ts:77-126`). This is
  an implementation capability, not evidence that the motion is comfortable or
  accessible.

### Input and navigation

- Logical input is click, double-click, scroll up/down, long-press/release,
  display wake, or wakeword. Clicks and long presses identify ring or glasses-arm
  sources (`app/ui/layers.ts:6-25`). There is no pointer, touch coordinate,
  eye-tracking, or freehand spatial-gesture contract.
- The established vocabulary is **scroll to move, click to activate,
  double-click to go back/yield focus, and long-press for a contextual menu or
  recovery path**. Compact glyphs exist for these actions
  (`app/ui/gestures.ts:1-23`).
- Lists already provide a visible selection, proportional scrollbar, and a
  450 ms edge detent before wrap (`app/ui/menu.ts:220-285,290-326`;
  `app/ui/edge-scroll.ts:1-75`).
- Some short action menus deliberately wrap immediately. In notification detail,
  one upward scroll moves from Back to Dismiss
  (`app/ui/notifications.ts:191-195,227-257`). Window menus similarly place Close
  window at the wrap target (`app/ui/window-menu.ts:82-116`). This is fast but
  error-prone for destructive or dismissive actions and should not become the
  default modern pattern.
- New-notification modals occupy a bordered **532 x 224** interior within the
  standard band (`app/ui/shell/modal-layer.ts:5-25,28-50`). Long text, multi-pane
  layouts, and dense action rows are poor fits.
- Voice is available for text entry, but recognition, privacy, noise, and speech
  accessibility make it an accelerator rather than a complete input model.

### Human constraints to design for

The display competes with an uncontrolled real-world background and with the
wearer's attention. A design must remain understandable under glare, darkness,
blur, display misalignment, reduced acuity or contrast sensitivity, monocular
use, fatigue, distraction, and intermittent transport. It must not assume that
color, audio, animation, spatial position, or speech is always perceivable.

The interface also handles private notifications, assistant text, health data,
and voice. Every interruption needs a source, age, dismissal, expiry, and clear
ownership. The existing MCP display threat model's no-autonomous-wake,
replace-only, bounded-content, TTL, cancellation, and stale-owner requirements
remain applicable (`notes/mcp-glasses-display-threat-model-2026-08-21.md:167-184`).

## Candidate solutions compared

The labels below are design hypotheses, not results of a user study. “High
potential” means the pattern is worth prototyping; it does not establish
glanceability or accessibility on the G2.

| Pattern | Expected glance benefit | Expected accessibility potential | Current implementation fit | Principal trade-off | Verdict |
|---|---|---|---|---|---|
| Replace-only glance card | High potential | High if text/shape are redundant | High | Too little context if over-compressed | Prototype first |
| Short linear list + detail | High potential | High with position and stable focus | High; extends `MenuLayer` | One extra step to reach detail | Prototype first |
| Confirmable action sheet | High potential | High with explicit labels | High | Confirmation adds friction | Prototype first |
| Tiered notifications/digest | High potential | High if urgency is not color-only | High; policy and shell work | Quiet cues may be missed | Prototype first |
| Reviewed voice input | Conditional | Conditional; requires non-voice path | Partial existing capability | Noise, privacy, recognition errors | Prototype with restrictions |
| Compact document/card stack | Conditional | Conditional; reading burden grows quickly | High via existing `DocumentView` | Encourages long glances | Stationary/detail hypothesis |
| Phone-companion handoff | High potential | Unknown until phone accessibility is verified | Requires generic handoff/navigation protocol | Breaks glasses-only flow | Design for complex work |
| Persistent dense dashboard | Low | Low | Possible but transport-expensive | Clutter and continuous attention | Reject |
| Spatial/world-locked AR | Unknown/low | Unknown | No tracking/input contract | Misregistration and safety | Out of scope/reject |
| Gaze dwell, air gestures | Unknown | Low without alternatives | Unsupported | Accidental activation/fatigue | Reject |
| Full-screen motion/parallax | Low | Low | Transport-expensive | Distraction and discomfort | Reject |

## Recommended patterns

### 1. Replace-only glance cards

Use a card with one short source/title, one primary message or value, an optional
secondary line, age/state, and at most one safe primary action. New state replaces
old state instead of growing a stack. Low-priority content must not wake the
display or steal focus. Every card has deterministic dismissal and expiry.

Why it fits:

- Google Glass guidance emphasizes brief, relevant, predictable, “fire and
  forget” interactions and concise text [1][2].
- HMD clutter research reports speed/accuracy costs and interference with
  attention to the real scene [4].
- It maps directly to the existing shell alert/modal and localized-delta model.

Trade-offs:

- Compression can remove context or make similar states ambiguous.
- One action cannot cover every workflow; detail must remain reachable.
- A timer or progress card needs explicit stale/disconnected state rather than
  looking live indefinitely.

Use for: incoming notification summaries, media state, timer completion,
connection changes, navigation next-step summaries, and assistant results.

### 2. Short linear lists with progressive disclosure

Use a shallow sequence: **summary/list -> selected detail -> actions**. Keep the
selection stable, show visible overflow and position, stop at ends by default,
and preserve double-click as universal back. Target approximately 3-7 meaningful
choices per level; longer collections need filtering, grouping, or phone handoff.

Why it fits:

- It uses the current scroll/click/back vocabulary and `MenuLayer` rather than
  inventing unsupported input.
- Recognition is easier than remembering hidden gesture modes; system-status,
  user-control, and error-prevention principles support visible state and
  predictable escape [14].
- Progressive disclosure keeps the ambient view sparse while retaining detail.
  Legacy Google Glass card/action patterns provide a concrete product precedent,
  not a G2 standard [3].

Trade-offs:

- It costs an extra interaction compared with a dashboard.
- Deep trees become slow and hard to remember.
- Circular wrapping weakens position and can put unsafe actions one gesture away.

Use for: launcher, notifications, media queues, settings summaries, and short
assistant-generated choices. Do not use instant wrap where the far item sends,
dismisses, closes, deletes, purchases, navigates, or discloses data.

### 3. Confirmable action sheets

Open a small action list from a selected object. Put Back or the safest default
first, name actions with verbs, separate consequential actions, and expose
pending/succeeded/failed/cancelled state. A destructive or externally visible
action requires two distinct intentional steps or a reliable undo.

Why it fits:

- It works with current layers and menus.
- It prevents one mistimed scroll/click from causing an irreversible result.
- It can preserve context while network/BLE work completes.

Trade-offs:

- Confirmation slows expert workflows.
- Async objects can disappear or mutate while the sheet is open; actions must be
  identity-bound and idempotent rather than applied to the new selection.

Use for: notification reply/dismiss, closing windows with unsaved state, calling
or messaging, navigation start, and assistant actions with side effects.

### 4. Tiered interruptions and quiet digests

Define explicit policy tiers:

- **Ambient/low:** update a stable icon/count or digest; never wake or focus.
- **Relevant/medium:** show one brief replace-only card when the display is
  already active.
- **Urgent:** use a salient visual plus optional audio/haptic cue only for a
  category the wearer has explicitly authorized.

Allow per-source priority, quiet periods, batching, redacted previews, and a
notification history. Encode urgency with words and shape/border as well as
luminance; do not depend on color or animation.

Why it fits:

- A smart-glasses study found a peripheral low-priority cue was slower to notice
  but rated least distracting; more highly animated conditions did not show a
  clear corresponding benefit [5].
- It complements Hermes's phone-side priority/quieting/digest direction rather
  than turning the lenses into a firehose.

Trade-offs:

- Quiet cues can be missed.
- Incorrect urgency classification damages trust.
- Context sensing can be wrong; explicit user policy must override automation.

### 5. Reviewed voice input with a non-voice path

Show clear listening and processing states, then a bounded transcript with
**Send, Edit/retry, and Discard**. Never auto-send consequential, private, or
low-confidence recognition. Keep recipient/destination visible through review.
Offer phone text entry or another non-voice route.

The current shell includes an opt-in wakeword `autoSend`/skip-confirmation path
(`app/ui/shell/voice-input.ts:61-64,173-200`). Its default-off status is useful
but does not satisfy this recommendation for consequential or private actions;
the destination/action policy must prohibit skip-confirmation in those cases.

Why it fits:

- Voice reduces visual and motor interaction when hands are occupied.
- Smart-glasses input research identifies multimodal input as a key direction,
  rather than a single universal modality [12].

Trade-offs:

- Speech is unreliable in noise, socially awkward in public, privacy-sensitive,
  and inaccessible to some users.
- Transcript review can become a long reading task.

### 6. Companion-phone handoff

Keep notifications, selection, and brief confirmation on the glasses. Move
credentials, permissions, authentication, long forms, long documents, recovery,
and complex editing to the phone. State what will open and preserve enough
context to resume; failure or cancellation must leave the glasses usable.

Why it fits:

- It acknowledges the real display/input envelope instead of simulating a phone
  UI at 640 x 480.
- It can provide a larger touch target and a path to platform accessibility,
  but no generic context-preserving handoff or verified TalkBack contract was
  identified in this audit. Those are implementation and validation work, not
  current capabilities.

Trade-offs:

- It interrupts the hands-free flow and requires a reachable phone.
- Cross-device state can drift; destination and completion need confirmation.

## Visual design rules

### Hierarchy and typography

- Establish a small role-based type ramp: primary value/title, body, metadata.
  Avoid arbitrary per-app sizes and more than two font families.
- Specify and test text in angular size on the real optics, not pixels alone.
  Microsoft reports roughly **0.35-0.4 degrees minimum character height** from
  its HoloLens studies [6]; treat this only as a starting hypothesis for G2
  hardware testing.
- Keep lines short, prefer one idea per line, and truncate only metadata. Essential
  text should wrap/reflow or move to a detail view.
- Use plain-language labels alongside compact gesture glyphs until the vocabulary
  is learned. Glyphs alone are not self-explanatory.

### Contrast and shape

- Start with the WCAG 2.2 text proxy of 4.5:1 for normal text and 3:1 for large
  text where framebuffer contrast is controllable [7]. This does not prove
  contrast against the real scene.
- Evaluate a stable high-luminance plate and/or strong outline behind essential
  text rather than drawing directly against arbitrary scenery. Compositor
  “opaque” means only non-transparent framebuffer content; it cannot occlude the
  optical scene. Optical see-through research found background texture,
  illuminance, and drawing style affected text identification [8], so the plate
  and outline remain real-optics hypotheses.
- Design first in two tones, then use the remaining grayscale for hierarchy.
  State must survive loss of intermediate shades.
- Pair icons with labels for unfamiliar, consequential, or ambiguous actions.
  Do not rely on emoji or missing-font fallbacks.

### Motion and feedback

- Reserve motion for state change, continuity, and boundary feedback. Keep it
  localized, brief, and settled; never use persistent pulsing or decorative
  parallax.
- Provide a reduced-motion setting and ensure the same boundary/state is visible
  without motion. WCAG's animation guidance identifies distraction, dizziness,
  nausea, and headache risks and requires interaction-triggered animation to be
  disableable unless essential [9].
- Intermediate frames may be dropped; correctness cannot depend on seeing every
  animation frame. Show a stable final state.
- Audio/haptic feedback may reinforce action but cannot be the only confirmation.

### Privacy and situational awareness

- Minimize lens content; provide a redacted preview mode for notifications,
  health, financial, location, and assistant content.
- Apply the W3C XR accessibility requirements as a requirements checklist and
  NIST Privacy Framework as a privacy-risk process baseline, while recognizing
  that neither validates this device or design [13][15].
- Show source and age; expire or mark stale content. Local dismissal, timeout,
  disconnect, and ownership change must prevent resurrection.
- Do not claim or imply camera/microphone privacy merely through an icon. Capture
  needs explicit wearer state and, where relevant, bystander-visible behavior;
  bystander studies found concern about subtle recording and interest in
  permission and recording controls [11].
- Suppress noncritical interruptions during high-load activity. Do not market
  current patterns for driving or safety-critical navigation without dedicated
  authorization and evidence. HMD aiming and overlay studies support a
  conservative stance on attentional tunneling [4][10].

## Fashionable patterns to avoid

- **“Iron Man” dashboards:** dense tiny metrics, constant monitoring, and scene
  competition are not modern usability.
- **Glassmorphism, translucency, gradients, neon severity:** unsuitable for
  4 bpp grayscale and uncontrolled backgrounds.
- **Infinite carousels and instant wrap for actions:** weak position and easy
  overshoot, especially when the far item is Dismiss or Close.
- **World-locked arrows/object labels:** no proven tracking, registration,
  occlusion, or safe fallback exists in the reviewed UI contract.
- **Gaze dwell, air gestures, multi-finger choreography:** unsupported and
  exclusionary without proven hardware and alternatives.
- **Notification firehoses and autonomous popups:** create habituation,
  distraction, privacy exposure, and focus churn.
- **Voice auto-send or always-listening “magic”:** hides recognition errors,
  destination ambiguity, and privacy state.
- **Full-screen transitions, parallax, elastic cards, persistent animation:**
  compete with the world and are transport-expensive.
- **Arbitrary generated HTML/Markdown/widgets:** unpredictable layout and actions;
  remote content should remain bounded inert data in an allowlisted schema.

## Evaluation framework

A candidate should be rejected before scoring if it obscures the real scene,
requires prolonged reading while moving, wakes for ordinary information, uses
one sensory channel as the sole state cue, permits one accidental gesture to
cause a consequential action, lacks escape/cancellation/failure state, reports
success before the relevant boundary confirms it, or can resurrect stale
content.

Score surviving patterns 0-4 in every category; require at least 3 in each
rather than allowing a high average to hide a safety failure:

1. visual accessibility;
2. cognitive load and visible system state;
3. situational awareness and glance duration;
4. interruption control;
5. discoverability and input alternatives;
6. error prevention and recovery;
7. privacy and redaction; and
8. renderer/transport feasibility.

### Proposed engineering and usability gates

These are Hermes G2 project targets, not external smart-glasses standards:

- No essential information is encoded only by shade, icon, position, audio, or
  motion.
- Enlarged text reflows or enters detail; it does not clip, overlap, or hide the
  escape/action controls.
- Low-priority content never wakes the display or steals focus.
- Every interruption exposes source, age, dismissal, and expiry.
- New asynchronous content cannot reset selection immediately before activation.
- Destructive/external actions need two distinct intentional steps or reliable
  undo; default focus is never destructive.
- Universal back/escape succeeds on the first attempt for at least 95% of test
  trials, with no action activation.
- Core open/move/select/back tasks reach at least 90% completion overall and in
  each recruited accessibility cohort. No cohort trails the total by more than
  10 percentage points without remediation.
- Zero uncorrected critical errors: unintended send/delete/disclosure, stale
  action on the wrong object, or failure to escape.
- A glance-target task proposes a 95th-percentile uninterrupted glance of no more
  than two seconds in a pedestrian simulator. This is a conservative project
  hypothesis, not proof of safe walking or driving.

Test combinations rather than one ideal lab case:

- novice/expert users and participants with low vision, contrast loss, monocular
  vision, limited dexterity, hearing loss, atypical speech, dyslexia, or
  attentional/cognitive fatigue;
- dark, mixed indoor, bright outdoor, backlit, reflective, dirty-lens, and
  misaligned-display conditions;
- seated, standing, conversation, carrying an object, gloves, noise, and a
  controlled pedestrian dual task; driving only in a simulator until separately
  authorized;
- dropped/delayed frames, duplicate input, reordered or removed selected items,
  stale data, disconnect/reconnect, screen off, low battery, timeout,
  cancellation, and late completion; and
- long/mixed-script/bidirectional text, missing glyphs, control characters,
  repeated alerts, secrets, URLs, markup, and misleading generated labels.

## Recommended delivery order

### P0: unify the design contract

- Define semantic roles for background, primary/secondary text, focus, border,
  disabled, warning, and destructive state using shades plus shape/text.
- Make universal scroll/select/back/menu/escape behavior explicit.
- Ban instant wrapping for any action sheet containing consequential items, or
  require confirmation/undo.
- Gate wakeword skip-confirmation by destination and side-effect risk; private or
  consequential voice flows always enter transcript review.
- Add reduced-motion, text-size, redacted-preview, and no-wake policy contracts.

### P1: prototype the two core surfaces

- Prototype one replace-only glance card and one short progressive-disclosure
  list using existing `Layer`, `MenuLayer`, modal, and worker-window patterns.
- Measure raster bounds and transport delta size; test two-tone degradation,
  long text, missing glyphs, stale async updates, and dropped intermediate frames.
- Do not broaden to spatial tracking or new gestures.

### P2: real-device formative testing

- On A32 + real G2, safely evaluate optical text size, backing/contrast, vertical
  placement, dominant/non-dominant eye, edge feedback with reduced motion,
  interruption timing, universal escape, and privacy/redaction.
- Record task success, errors, uninterrupted glance duration, missed alerts,
  subjective distraction, and transport latency. Do not infer these from builds
  or screenshots.

### P3: migrate by risk and frequency

1. shell alerts and notification summary/detail/action flows;
2. common launcher and media lists;
3. assistant and voice review states;
4. health/status cards; then
5. stationary document/detail views.

Retain the phone handoff for complex work. Do not turn every screen into a card
or force a single visual template where the task differs.

## Clear recommendation

Proceed with a **glance card + shallow list + confirmable action sheet** system,
backed by tiered interruptions, reviewed multimodal input, and phone handoff.
Treat stable opaque hierarchy, explicit state, and predictable escape as the
modern design language. Prototype and measure these patterns on the real G2
before changing the whole shell.

Do not pursue dense dashboards, color/translucency-led styling, world-locked AR,
unsupported gaze/air gestures, notification firehoses, instant-wrap destructive
actions, or full-screen decorative motion. The first concrete design review
should focus on notification summary/detail/actions because it exercises
interruption, private content, lists, voice, dismissal, async identity, and
error recovery in one bounded flow.

## Sources

1. Google for Developers, “Glass Design Principles”: https://developers.google.com/glass/design/principles
2. Google for Developers, “Glass Style”: https://developers.google.com/glass/design/style
3. Google for Developers, “Glass Design Patterns”: https://developers.google.com/glass/design/patterns
4. Warden et al. (2025), “Clutter costs in head-mounted displays,” *Cognitive Research: Principles and Implications*: https://doi.org/10.1186/s41235-025-00650-5
5. Faulhaber, Hoppe, and Schmidt (2022), “Evaluation of visual notification cues for smart glasses,” *i-com*: https://doi.org/10.1515/icom-2022-0022
6. Microsoft Mixed Reality, “Typography”: https://learn.microsoft.com/en-us/windows/mixed-reality/design/typography
7. W3C, WCAG 2.2 Understanding SC 1.4.3, Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
8. Gabbard, Swan, and Hix (2006), “The effects of text drawing styles, background textures, and natural lighting on text legibility in outdoor augmented reality,” *Presence*: https://doi.org/10.1162/pres.15.1.16
9. W3C, WCAG 2.2 Understanding SC 2.3.3, Animation from Interactions: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
10. van der Burg et al. (2024), “The attentional costs of aiming a head-mounted display,” *Human Factors*: https://doi.org/10.1177/00187208241236395
11. Denning, Dehlawi, and Kohno (2014), “In situ with bystanders of augmented reality glasses,” CHI: https://doi.org/10.1145/2556288.2557352
12. Lee and Hui (2018), “Interaction methods for smart glasses: a survey,” *IEEE Access*: https://doi.org/10.1109/ACCESS.2018.2831081
13. W3C, XR Accessibility User Requirements: https://www.w3.org/TR/xaur/
14. Nielsen Norman Group, “10 Usability Heuristics for User Interface Design”: https://www.nngroup.com/articles/ten-usability-heuristics/
15. NIST Privacy Framework: https://www.nist.gov/privacy-framework
