import { MotionService, type MotionCalibrationRecordV1 } from "../motion/motion-service";
import { getStringSetting, setStringSetting } from "./settings-store";
import type { FaceclawCommunicatorBridge } from "./faceclaw-communicator";

declare const java: any;

const CALIBRATION_KEY = "motion.calibration.v1";
const DEVICE_SALT_KEY = "motion.deviceBindingSalt";

function loadCalibration(): unknown {
  const raw = getStringSetting(CALIBRATION_KEY, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCalibration(record: MotionCalibrationRecordV1): boolean {
  // This compact summary intentionally contains no raw motion sample history.
  const serialized = JSON.stringify(record);
  setStringSetting(CALIBRATION_KEY, serialized);
  return getStringSetting(CALIBRATION_KEY, "") === serialized;
}

function opaqueDeviceId(address: string): string {
  let salt = getStringSetting(DEVICE_SALT_KEY, "");
  if (!salt) {
    salt = String(java.util.UUID.randomUUID().toString());
    setStringSetting(DEVICE_SALT_KEY, salt);
  }
  // Install-local salted identity: stable for restart/device mismatch checks,
  // but the ordinary calibration record never contains the raw BLE address.
  let hash = 0x811c9dc5;
  for (const char of `${salt}\u0000${address}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `g2-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export const glassesMotionService = new MotionService({
  now: () => Date.now(),
  persistence: { load: loadCalibration, save: saveCalibration },
});

let sessionGeneration = 0;

export function bindGlassesMotionService(
  communicator: FaceclawCommunicatorBridge,
  deviceId: string,
): number {
  sessionGeneration++;
  glassesMotionService.bind(communicator, {
    deviceId: opaqueDeviceId(deviceId),
    sessionGeneration,
  });
  return sessionGeneration;
}

export function retireGlassesMotionSession(): void {
  sessionGeneration++;
  glassesMotionService.unbind();
}
