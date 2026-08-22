import { MotionService, type MotionCalibrationRecordV1 } from "../motion/motion-service";
import { getStringSetting, setStringSetting } from "./settings-store";
import type { FaceclawCommunicatorBridge } from "./faceclaw-communicator";

const CALIBRATION_KEY = "motion.calibration.v1";

function loadCalibration(): unknown {
  const raw = getStringSetting(CALIBRATION_KEY, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCalibration(record: MotionCalibrationRecordV1): void {
  // This compact summary intentionally contains no raw motion sample history.
  setStringSetting(CALIBRATION_KEY, JSON.stringify(record));
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
  glassesMotionService.bind(communicator, { deviceId, sessionGeneration });
  return sessionGeneration;
}

export function retireGlassesMotionSession(): void {
  sessionGeneration++;
  glassesMotionService.unbind();
}
