# Hermes G2 phone UI design language

## Direction: quiet technical companion

Hermes G2 uses a calm, dark interface that feels like a dependable instrument rather than a generic settings app. Information is grouped into clearly bounded surfaces, mint identifies the primary path, blue identifies optional navigation, amber identifies conditions that need attention, and red is reserved for destructive actions. The phone interface should remain visually related to the monochrome, information-dense G2 display without imitating its hardware limits.

The Health dashboard is the reference for information hierarchy. Settings, credential management, installed-app lists, shell warnings, and shared controls use the same palette, type scale, spacing rhythm, surface treatment, and action hierarchy.

## Device and renderer constraints

The phone UI is NativeScript 9 on Android, while the glasses UI is a separate 576 × 288 monochrome renderer. This language applies to `app/phone-ui` and must not be inferred to change the glasses renderer.

To keep layout and rendering predictable on the supported Android devices:

- use solid colors, one-pixel borders, and shallow layout trees;
- use the Android system sans-serif instead of an unbundled font;
- use NativeScript-supported literal properties and DIP-sized values;
- avoid CSS custom properties, `calc`, gradients, shadows, blur, transitions, continuous animation, media queries, `gap`, and web-only positioning;
- keep touch controls at least 48 DIP high and list/settings rows at least 56 DIP high;
- preserve text labels for status; color must reinforce meaning rather than carry it alone;
- let supporting copy wrap, avoid fixed widths where possible, and verify narrow screens and enlarged text on hardware;
- keep charts bounded and update existing drawing children rather than adding decorative effects.

Literal color values are intentional because NativeScript CSS custom properties have not been reliable in this app. `tests/phone-ui-theme.test.mjs` enforces the source contract.

## Foundation

### Color roles

| Role | Value | Use |
| --- | --- | --- |
| Background | `#0F1411` | Page and scroll background |
| Action bar | `#101512` | Top and bottom chrome |
| Surface | `#172019` | Cards, rows, banners, neutral buttons |
| Raised surface | `#1E2A22` | Inputs and selected control background |
| Border | `#24312A` | Surface separation and dividers |
| Primary text | `#EAF2EC` | Titles and body text |
| Muted text | `#9BB0A5` | Supporting text, labels, metadata |
| Primary | `#57D8A6` | Main action, selection, connected/success |
| Primary pressed | `#46B88C` | Pressed primary action |
| On primary | `#08120D` | Text on mint and red action fills |
| Secondary | `#4C9DF5` | Optional navigation and informational state |
| Warning | `#F5C542` | Attention needed, non-destructive |
| Danger | `#E5484D` | Explicit credential clearing/destructive action |

Do not add a color literal without first defining its semantic role here and extending the theme contract test.

### Typography

The phone UI uses Android's system sans-serif. The compact type scale is:

- 28: display value or page-level hero;
- 20 bold: section heading;
- 16: row title;
- 15: body and controls;
- 13: supporting text and field labels;
- 12 tracked uppercase: eyebrow/section label and chart caption.

Text is rendered exactly as authored. Uppercase is opt-in through `.section-label`; ordinary labels must not be automatically title-cased.

### Spacing and shape

Use the 4, 8, 12, 16, 20, 24 DIP spacing rhythm. Screen content uses 20 DIP padding. Controls use an 8 DIP radius, ordinary cards and banners use 12, and feature/onboarding cards use 16. Avoid one-off spacing values unless a constrained layout such as a chart or gesture grid requires them.

## Reusable patterns

- `.screen-content`: standard page inset.
- `.surface-card`: grouped related content.
- `.feature-card`: larger, high-emphasis surface.
- `.section-heading`, `.section-label`, `.body-text`, `.supporting-text`, `.field-label`: semantic type roles.
- `.control-row`: a 56-DIP settings row containing a native switch, slider, or segmented control.
- `.list-row`, `.list-row-title`: installed-app and other tappable list rows.
- `.status-banner` with `.status-info`, `.status-warning`, or `.status-danger`: visible state that always retains explanatory text.
- the Android shell enforces a 56-DIP native tab-layout minimum to survive the
  NativeScript grid's extra density normalisation; hardware bounds, not the
  source constant alone, are the acceptance evidence.
- `Button.-primary`: one main action for the current decision.
- `Button.-secondary`: optional navigation, retry, refresh, or back.
- `Button.-danger`: immediate destructive action. The dark on-danger text is deliberate for readable contrast.

Prefer semantic classes over inline visual attributes. Bindings, event handlers, secure-field behavior, and platform controls remain the source of interaction behavior; visual refactors must not replace them with simulated controls.

## Representative adoption

The first vertical slice applies this language to:

- the four-tab shell chrome and global Android controls in `app/app.css`;
- the Settings hub, using grouped surfaces and explicit supporting copy;
- the API Keys & Bridge screen, using grouped credential surfaces, secure inputs, and visually explicit clear actions;
- installed notification and media app lists, using reusable 56-DIP rows;
- Glasses and Health attention states, using one warning-banner and action hierarchy.

Existing Health metric cards and onboarding feature cards remain compatible aliases while later screens migrate incrementally. New phone screens should start with the semantic patterns above rather than adding another screen-specific card, text, or button system.

## Review checklist

- Does every color communicate one documented role?
- Is there only one visually primary action for a decision?
- Are destructive actions explicit and visually distinct?
- Does supporting text wrap without relying on fixed widths?
- Are controls at least 48 DIP and rows at least 56 DIP?
- Is status understandable without color alone?
- Are credentials still masked, replace-only, and explicitly clearable?
- Are existing bindings and handlers unchanged?
- Do focused theme tests, the full host suite, typecheck, Android build, and `git diff --check` pass?
- On hardware, do launch, tab navigation, Settings scroll, secure fields, warning surfaces, enlarged text, and PID-filtered logs remain clean?
