# Galaxy Z Fold7 phone compatibility acceptance matrix — 22 August 2026

This matrix concerns only the Android phone companion UI. It does not alter or
claim evidence for G2/R1 pairing, firmware, permissions, BLE hardware, or the
existing G2 compositor or stock 288px window-band contract.

## Authoritative premises

- Samsung identifies the Galaxy Z Fold7 pre-release device family as SM-F966 and
  documents an 8.0-inch main screen and 6.5-inch cover screen:
  https://www.samsung.com/us/smartphones/galaxy-z-fold7/
- Android window size classes are dynamic across folding, orientation, and
  multitasking; compact width is below 600dp, medium is 600–839dp, and expanded
  starts at 840dp:
  https://developer.android.com/develop/ui/views/layout/use-window-size-classes
- Android 16 ignores orientation/resizability restrictions on large screens, so
  portrait locking is not a compatibility strategy:
  https://developer.android.com/about/versions/16/behavior-changes-16
- Target-SDK 35 apps are edge-to-edge on Android 15 and must handle system-bar,
  cutout, and IME insets:
  https://developer.android.com/develop/ui/views/layout/edge-to-edge
- Every packaged native library and the APK ZIP layout must support 16 KiB pages:
  https://developer.android.com/guide/practices/page-sizes

## Finite host/emulator contract

| Fixture | Bounds (dp) | Expected | Acceptance |
|---|---:|---|---|
| Fold7-like cover portrait | 360×800 | compact/medium portrait | navigation and all controls visible; content scrolls; 48dp touch targets |
| Fold7-like unfolded portrait | 720×850 | medium/medium portrait | live resize without activity crash; readable bounded content |
| Fold7-like unfolded landscape | 850×720 | expanded/medium landscape | no portrait-lock dependency; no fixed-width overflow |
| Tabletop / shallow window | 720×430 | medium/compact landscape | controls and logs remain scrollable; IME uses resize |
| Split screen | 360×850 | compact/medium portrait | recompute from app window, not physical display |
| Font scale 1.0/1.3/2.0 | all above | wrapped labels | no fixed text container height; navigation remains reachable |
| G2 compositor | existing 640×480 custom surface / 288px standard band | unchanged | phone changes do not alter glasses geometry; no broader firmware compatibility claim |
| APK arm64 | arm64-v8a | complete inventory | all ELF LOAD alignments >= 0x4000; `zipalign -P 16` passes |

## Evidence levels

- Automated host configuration/layout contracts: required.
- Clean JDK 21 / SDK 35 debug APK build and static APK inspection: required.
- Emulator screenshots: best effort when a usable AVD exists.
- Physical Galaxy Z Fold7 install/launch/process: passed for the exact debug APK
  on an authorised SM-F966B (`q7q`) running Android 16 / SDK 36.
- Both G2 arms reached session ready and direct R1 BLE connected after Bluetooth
  was enabled. The owner observed no R1 indicator on the glasses HUD.
- Unlocked Hermes-phone visual, physical fold-posture transition, rotation,
  tabletop, and multi-window testing: not observed. Install/process and BLE
  session proof must not be inflated into those missing hardware claims.
