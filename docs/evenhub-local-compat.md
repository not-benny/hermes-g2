# Local-only EvenHub compatibility foundation

## Scope and provenance

Hermes reviewed Faceclaw commit `6e4ece5dc7eda9d4cae1de966b6c6f29712d53c2`
against Hermes baseline `f02d8f88bb44e147dad213e36a2ab16ad304aebe`. The
upstream implementation established useful vocabulary for packages, display,
input, storage, timers, permissions, and lifecycle, but its WebView, storefront,
archive extraction, sensors, credentials, networking, and background execution
are not imported. Faceclaw and Hermes G2 are GPL-3.0 projects. New sample code is
GPL-3.0-only and authored in this repository.

EvenHub and Even Realities are trademarks of their respective owners. This
compatibility work is unofficial and is not endorsed by Even Realities.

## Delivered boundary

The bundled Local Counter is a declarative, compile-time allowlisted package. Its
canonical content has SHA-256
`afb4bb9028e1e8e4fba211aeb0bf8c5e3b72573c4c971aaddc444683f95b54ad`.
The manifest records package ID, semantic version, permissions, hash, source and
license. The runtime accepts only this exact source identity.

The V1 host schema allowlists six methods: inert display replacement, namespaced
storage get/set/remove, and one-shot timer set/clear. Requests require an exact
live session generation and a unique bounded request ID. Unknown fields,
methods, package identities, grants, malformed values, stale generations and
replays fail closed. Display content uses only text, key/value, progress,
divider and bounded action primitives; HTML, scripts, images, URLs and native
handles do not exist in the schema.

Each session owns its request tombstones, event queue and timers. Backgrounding,
screen-off and close synchronously cancel timers. Close tombstones the exact
session before cleanup, so stale callbacks and stale closes cannot affect a
replacement generation. Input is accepted only while the exact session is live,
foreground, screen-on and granted input permission.

Storage is one app/hash-specific settings document with a 16 KiB storage quota,
32 keys and 2 KiB per value. The window menu exposes **Clear local data**;
Android app-data clear or uninstall also removes it. The bundled sample itself
is part of Hermes and is not separately uninstallable.

## Privacy and resource policy

The Local Counter uses no network, account, API key, arbitrary URL, raw
filesystem, WebView, downloaded code, assistant tool, BLE command or Android
runtime permission. Microphone, location, and accelerometer are unavailable to
this foundation. A package cannot declare or invoke those capabilities.

Limits are 16 KiB per bridge message, 8 KiB display text, 32 blocks, eight
actions, 16 queued events, four active one-shot timers, 250 ms through 60 second
timer delays, 256 requests per session, and one active compatibility session.
Timers are suspended rather than retained in the background.

## Explicit NO-GO items

Store-backed installation remains **NO-GO**. There is no store client, remote
package fetch, API signing key, arbitrary HTTPS host, user-supplied URL or remote
code path. EHPK parsing and extraction are deliberately not included: upstream
did not verify the package footer, bound decompression, authenticate publishers,
or safely confine archive paths, and the referenced parser provenance was not
available for audit. Future EHPK work requires a clean provenance record,
overflow-safe bounded parser, canonical path confinement, signature or pinned
hash verification, transactional installation, per-package consent and a new
independent security review.

Sensor extensions, API-key sharing, assistant-tool registration, multiple or
background apps, raw filesystem access, WebView execution, firmware extensions,
and store-backed installation remain separate gated outcomes.

## Verification

Run:

- `node --test tests/evenhub-compat.test.mjs`
- `npm run test`
- `npm run typecheck`
- `JAVA_HOME=/usr/lib/jvm/java-21-openjdk ANDROID_HOME=/home/benny/Android/Sdk npm run build`
- `git diff --check`

Real G2 evidence must include the sample rendering on the lens and a wearer
scroll/click changing the counter. A build or A32 launch alone is not G2 input
evidence.
