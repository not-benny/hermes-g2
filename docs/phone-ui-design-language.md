# Hermes G2 phone UI design language

## Direction: quiet technical companion

Hermes G2 uses a calm, dark phone interface that reads as a dependable
instrument rather than a generic settings app. Information is grouped into
bounded surfaces. Mint identifies the primary path, blue identifies optional
navigation or information, amber identifies conditions needing attention, and
red is reserved for destructive actions. Text always states the meaning; color
is never the only status signal.

This contract applies to the NativeScript Android UI under `app/phone-ui`. It
does not change the glasses renderer. The current glasses path uses a 640 × 480
framebuffer, a centered 576-pixel wearer-visible width, and either a standard
288-pixel window band or the full-height canvas. Wearer-facing visual work is
governed by [`glasses-design-system.md`](glasses-design-system.md).

## Device and renderer constraints

Use predictable NativeScript primitives on supported Android phones:

- use solid colors, one-pixel borders, and shallow layout trees;
- use the Android system sans-serif instead of an unbundled phone font;
- use literal NativeScript-supported DIP values;
- avoid CSS custom properties, `calc`, gradients, shadows, blur, transitions,
  animation, media queries, `gap`, and web-only positioning;
- keep buttons, fields, sliders, switches, and segmented controls at least 48
  DIP high;
- keep list and settings rows at least 56 DIP high;
- keep every non-text control and text field explicitly labelled for Android
  accessibility services;
- preserve visible text labels for status and destructive actions;
- allow supporting copy to wrap and avoid fixed widths except in measured
  preview, chart, and gesture-control layouts; and
- update existing chart children rather than adding decorative animation.

`.screen-content`, `.phone-content`, and the legacy `.p-20` container remain
full-width on a narrow cover screen and are capped at 840 DIP on unfolded or
desktop-sized windows. Live cover, unfolded, rotation, tabletop, and split
classification remains owned by the existing window-layout code.

The Android bottom tab implementation requests a 56-DIP native minimum through
exactly one `Utils.layout.toDevicePixels` conversion in `shell-page.ts`. This is
a source contract, not physical evidence: every target device must still measure
the resulting tab bounds in DIPs. The theme does not own or freeze the tab
inventory.

## Foundation

### Color roles

| Role            | Value     | Use                                                        |
| --------------- | --------- | ---------------------------------------------------------- |
| Background      | `#0F1411` | Page and scroll background                                 |
| Action bar      | `#101512` | Top and bottom chrome                                      |
| Surface         | `#172019` | Cards, rows, banners, neutral buttons                      |
| Raised surface  | `#1E2A22` | Inputs and pressed controls                                |
| Border          | `#24312A` | Surface separation and dividers                            |
| Primary text    | `#EAF2EC` | Titles and body text                                       |
| Muted text      | `#9BB0A5` | Supporting text, labels, metadata                          |
| Primary         | `#57D8A6` | Main action, selection, connected state                    |
| Primary pressed | `#46B88C` | Pressed primary action                                     |
| On primary      | `#08120D` | Text on mint and red action fills                          |
| Secondary       | `#4C9DF5` | Optional navigation and information                        |
| Warning         | `#F5C542` | Attention needed, non-destructive                          |
| Danger          | `#E5484D` | Destructive status and standard danger action              |
| Active danger   | `#B62328` | Light-text destructive actions requiring stronger contrast |

The tested foreground/background pairs meet WCAG AA contrast for normal text.
Do not add a phone-theme color literal without defining its role and extending
the palette and contrast tests.

### Typography

The phone UI uses Android's system sans-serif with this compact scale:

- 28 DIP: display value or page-level hero;
- 20 DIP bold: section heading;
- 16 DIP: row title;
- 15 DIP: body and controls;
- 13 DIP: supporting text and field labels; and
- 12 DIP tracked uppercase: eyebrow, section label, and chart caption.

Text is rendered exactly as authored. Uppercase is opt-in through
`.section-label`; ordinary labels and buttons are not automatically title-cased.

### Spacing and shape

Use the 4, 8, 12, 16, 20, and 24 DIP spacing rhythm. Screen content uses 20 DIP
padding. Controls use an 8 DIP radius, ordinary cards and banners use 12, and
feature or onboarding cards use 16. Avoid one-off spacing unless a constrained
preview, chart, or gesture grid requires it.

## Reusable patterns

- `.screen-content`: standard inset plus the Fold7 width cap.
- `.surface-card`: grouped related content.
- `.feature-card`: larger high-emphasis surface.
- `.section-heading`, `.section-label`, `.body-text`, `.supporting-text`, and
  `.field-label`: semantic text roles.
- `.control-row`: a 56-DIP settings row containing a platform control.
- `.list-row` and `.list-row-title`: tappable installed-app rows.
- `.status-banner` with `.status-info`, `.status-warning`, or `.status-danger`:
  explanatory state reinforced by color.
- `Button.-primary`: the main action for the current decision.
- `Button.-secondary`: navigation, retry, refresh, or back.
- `Button.-danger`: an immediate destructive action.

Prefer semantic classes over inline visual attributes. Visual refactors must
preserve bindings, event handlers, secure-field behavior, platform controls,
and live layout ownership.

## Current representative adoption

The maintained vertical slice covers:

- global phone typography, palette, control sizing, and current bottom-tab
  shell sizing;
- Settings, including the live-captions route and grouped explanatory copy;
- live-caption privacy, language, readability, speaker-evidence, and bounded
  vocabulary settings without changing their bindings;
- API keys and bridge settings, retaining masked replace-only inputs and
  explicit clear actions;
- notification triage and media-source lists, retaining precedence, reset,
  per-app tier, refresh, selection, and back actions;
- Glasses and Health attention banners;
- the Hermes companion tab, including announced dynamic status, hidden
  decorative glyphs, and readable destructive actions;
- current reader actions and their accessibility labels; and
- explicit Android accessibility labels for every current phone text field,
  slider, switch, and segmented control.

Existing Health metrics, onboarding cards, and other legacy screens remain
compatible aliases. New phone screens should start with the semantic patterns
instead of introducing another one-off card, text, or button system.

## Privacy invariants

- Secret fields stay secure and never bind stored secret values back into XML.
- Empty secret drafts mean “keep”; clearing remains a distinct explicit action.
- Caption disclosure, volatile retention, and provider-evidence wording remain
  visible and unchanged in meaning.
- Styling adds no persistence, telemetry, network request, screenshot, or log.
- Accessibility labels name controls but never contain a credential value,
  transcript, device identifier, or other private content.

## Review checklist

- Is every color assigned one documented role and backed by readable text?
- Do normal-text foreground/background pairs meet WCAG AA contrast?
- Is there only one visually primary action for a decision?
- Are destructive actions explicit and visually distinct?
- Are controls at least 48 DIP and rows at least 56 DIP?
- Do text fields and non-text controls have useful accessibility labels?
- Does supporting text wrap on cover and enlarged-font layouts?
- Do unfolded pages remain capped without changing live layout behavior?
- Are credentials still masked, replace-only, and explicitly clearable?
- Are caption, notification, reader, and settings bindings intact?
- Do focused tests, the full suite, XML parsing, typecheck, Android build, APK
  verification, and `git diff --check` pass?
- On hardware, do cover/unfolded/landscape/tabletop/split layouts, TalkBack,
  enlarged text, secure fields, warning surfaces, and actual DIP bounds pass?
