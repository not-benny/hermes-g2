# G2 protobuf transport primitives

## Descriptor provenance

The field layout is derived from `g2-kit-unofficial` generated descriptors at pinned upstream commit `33da3a7ec2b905ca7148acad69f105a0986b3fb7`, specifically `ble/gen/g2_setting_pb.ts`, `dev_config_protocol_pb.ts`, `dev_settings_pb.ts`, and `service_id_def_pb.ts`. Generated code is not copied into Hermes and no protobuf dependency is added.

## Encoders

`BleProtocol.buildSetGlassGridDistance(magic, value)` and `buildSetGlassGridHeight(magic, value)` encode a `G2SettingPackage` on sid `0x09`:

- `commandId` field 1 = `1` (`DeviceReceiveInfo`)
- `magic` field 2
- `deviceReceiveInfoFromApp` field 3
- X distance field 3, or Y height field 2, containing uint32 field 1

For one-byte values, the vectors are `08 01 10 MM 1A 04 1A 02 08 VV` (distance) and `08 01 10 MM 1A 04 12 02 08 VV` (height). Multi-byte varints and zero are covered by `tests/g2-proto-transport.test.mjs`.

The package-internal `BleProtocol.buildQuickRestart(magic)` encoder describes `DevCfgDataPackage` on sid `0x80`: command id 15, magic field 2, empty `quickRestart` message field 14, yielding `08 0F 10 MM 72 00`. It is intentionally not wrapped, queued, exposed through the communicator, or exposed to NativeScript.

## Runtime and safety boundary

Distance and height have package-internal `MessageBuilder` ACK-tracked wrappers only. No communicator/UI setter, automatic send, arbitrary sid/payload API, restore-factory operation, or DeviceSettings runtime write exists. Coordinate validation is limited to non-negative Java `int` values; the device-specific user-facing safe range remains a later controls-layer decision. Quick restart is **NO-GO** pending a separately authorized operational card covering outer flag/arm/session behavior with Benny present. No factory reset, unpair, firmware/DFU, or destructive recovery is part of this work.
