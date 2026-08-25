# Hermes G2 glasses design system

## Direction

The glasses UI is a quiet, high-contrast instrument. It uses one visual
language across the HUD, launcher, menus, Assistant, notifications, media,
Clock, and Conversate. Structure comes from spacing, stable gray roles, crisp
source identity, and clear focus ownership rather than decoration.

This contract applies only to the wearer-facing renderer. The phone UI has its
own documented design language.

## Hardware contract

- The compositor uses a 640 x 480 logical framebuffer.
- The centered 576-pixel optical width from x=32 through x=607 reaches the
  wearer. Meaningful glance-card content must stay inside it.
- Standard windows use a 288-pixel-high band. Full-height windows are reserved
  for surfaces that genuinely need the space.
- The transport packs grayscale pixels to 4 bits. Semantic tones therefore sit
  on distinct wire shades instead of relying on small 8-bit differences.
- Shell pixel zero is transparent. Opaque black is gray value 1, which packs to
  wire black without exposing retained surfaces below it.

## Foundation

The canonical implementation is `app/ui/glass-design.ts`.

### Tone roles

| Role          | Gray value | Wire shade | Use                                     |
| ------------- | ---------: | ---------: | --------------------------------------- |
| Opaque black  |          1 |          0 | Shell-owned card and modal backgrounds  |
| Selected fill |         16 |          1 | Focused row and fallback identity plate |
| Track         |         48 |          3 | Quiet outlines and progress tracks      |
| Divider       |         64 |          4 | Section and ownership boundaries        |
| Border        |         96 |          6 | Cards and focused selection outlines    |
| Hint          |        112 |          7 | Gesture help and low-priority status    |
| Muted         |        144 |          9 | Metadata and secondary labels           |
| Secondary     |        176 |         11 | Supporting copy and inactive controls   |
| Body          |        208 |         13 | Ordinary readable content               |
| Primary       |        224 |         14 | Titles, results, and current values     |
| Focus         |        255 |         15 | Exact current target and critical title |

Do not add a nearby gray literal for ordinary UI. Reuse the semantic role. A
new role must remain distinct after `(value + 8) >> 4` packing.

### Spacing and shape

- Use the 2, 4, 8, 12, 16, and 24 pixel rhythm.
- Selection corners use a 6-pixel radius.
- Controls and compact content cards use an 8-pixel radius.
- Glance cards use a 12-pixel radius.
- Dividers are one pixel. A focused selection adds one two-pixel rail, not a
  second decorative frame.

### Type hierarchy

- Large: Clock alerts and user-selected large notification text only.
- Medium: card titles, page titles, and primary values.
- Small: ordinary body copy, metadata, counts, and gesture help.
- Notification title and body text follow the Notification text size setting.
  Source-app identity stays compact so changing readability never removes it.

## Reusable behavior

### Cards and panels

`drawGlassPanel` paints one fill and one outline. It is the shared primitive for
Assistant, voice capture, notification, Now Playing, media volume, notification
list, and Conversate cards. Shell-owned heads-up cards remain fully opaque and
must not call `paintBelow`.

### Selection and focus

`drawGlassSelection` is used by menus, launcher rows and cells, notifications,
and split-pane apps. An unfocused selection is an outline. The focused owner
adds shade-1 fill and a two-pixel bright rail. This makes input ownership clear
without depending on motion or color.

### Progress

`drawGlassProgress` is the shared rounded track for Now Playing, the Music app,
and volume. It clamps values before drawing and performs at most two raster
operations.

### Motion

- Heads-up notification and Clock cards appear atomically after compositor
  isolation. They do not animate through a retained HUD frame.
- Now Playing uses a bounded 240 ms entry, 220 ms exit, and 24 ms local ticker.
- No global animation clock, blur, shadow, gradient, or decorative idle motion
  is allowed. Motion must communicate a state transition and stop afterward.

## Notification source identity

Fresh notification cards resolve the cached 24 x 24 grayscale icon for the
exact Android notification key. A cache miss paints a deterministic initial
from the app name, or the final package-name segment, inside a 28 x 28 badge.
The stale-cache path requests a later fresh render and never blocks the first
card paint on Android drawable conversion.

At a 640-pixel logical width:

- the identity badge begins at x=36 and ends at x=63;
- source text begins at x=72 and is truncated before x=608;
- title, body, and footer occupy x=32 through x=607, exactly 576 visible
  pixels; and
- the prior implementation also exposed only 576 message pixels after optical
  clipping, so adding identity does not reduce wearer-visible message area.

The cached-icon path adds two bounded operations over the earlier card: one
24 x 24 blit and one 576-pixel divider. The fallback path adds four operations.
The cached path touches 1,152 additional raster pixels; the fallback plate,
outline, divider, and one glyph remain below 1,700 additional pixel writes.
Wire-frame dimensions and the existing 120-pixel changed strip are unchanged.
Neither path adds a timer, network request, persistence, or global render tick.

## Surface adoption

- HUD and sidebar: stable divider, telemetry, focus, and management tones.
- Launcher and menus: shared selection rail, type roles, spacing, and footer.
- Assistant and voice: the same compact optical card frame and hierarchy.
- Notifications: shared cards and selections in heads-up, digest, list, detail,
  and action surfaces, plus exact app identity on heads-up cards.
- Now Playing and Music: optical-safe art and all three transport controls,
  shared progress, metadata roles, and modal framing.
- Clock: focused critical title, primary label, secondary grouping and action.
- Conversate: bounded provider and cue panels, shared dividers, type roles, and
  footer treatment without changing capture or privacy behavior.

## Performance and lifecycle invariants

- Preserve strict frame acknowledgement and existing retained-layer ownership.
- Do not wake, unblank, sleep, dismiss, or transfer input from a paint method.
- Cached notification data may request a later fresh frame but must not block a
  stale-allowed render pass.
- A shared primitive must have a fixed operation count independent of content.
- Text wrapping and list pagination remain bounded before painting.
- No visual refactor may widen plaintext retention, logging, or transport.

## Known hardware limits

- Android notification icons arrive as 24 x 24 grayscale bitmaps. Fine brand
  detail and color cannot survive the optical and 4-bit conversion.
- Apps that expose no drawable use the deterministic identity initial.
- Rounded edges and subtle fills can look identical at some brightness levels;
  focus therefore also has a geometric rail.
- Repository geometry and render tests verify bounds and wire shades. Final
  optical comfort, ghosting, and brightness still require worn-glasses testing.

## Review checklist

- Does every meaningful pixel stay inside the optical raster or documented
  standard window band?
- Do tone roles remain distinct after 4-bit packing?
- Is the current input owner obvious without color or animation?
- Does notification text still follow its readability setting?
- Are opaque cards still blank-first and lifecycle-neutral while painting?
- Are paint operations bounded and free of new global timers?
- Do focused tests, the full suite, typecheck, formatting, and diff checks pass?
