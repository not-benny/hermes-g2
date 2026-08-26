import { ApplicationSettings } from "@nativescript/core";
import {
  applyRingHealthIdentityChange,
  bindRingHealthIdentityAtBoot,
  isRingHealthPersistenceIdentityReady,
} from "../health/ring-health-identity";

export type DeviceAddresses = {
  right: string;
  left: string;
  ring: string;
};

const ADDRESS_KEYS = {
  right: "deviceAddress.right",
  left: "deviceAddress.left",
  ring: "deviceAddress.ring",
} as const;

const DEFAULT_DEVICE_ADDRESSES: DeviceAddresses = {
  right: "",
  left: "",
  ring: "",
};

export function loadDeviceAddresses(): DeviceAddresses {
  return {
    right: normalizeMacAddress(ApplicationSettings.getString(ADDRESS_KEYS.right, DEFAULT_DEVICE_ADDRESSES.right)),
    left: normalizeMacAddress(ApplicationSettings.getString(ADDRESS_KEYS.left, DEFAULT_DEVICE_ADDRESSES.left)),
    ring: normalizeMacAddress(ApplicationSettings.getString(ADDRESS_KEYS.ring, DEFAULT_DEVICE_ADDRESSES.ring)),
  };
}

export function saveDeviceAddresses(addresses: DeviceAddresses): void {
  const normalized = {
    right: normalizeMacAddress(addresses.right),
    left: normalizeMacAddress(addresses.left),
    ring: normalizeMacAddress(addresses.ring),
  };
  const previousRing = loadDeviceAddresses().ring;
  if (previousRing !== normalized.ring) {
    // Publish and synchronously flush the new ring authority first. From this
    // point late frames from the old communicator fail its address-generation
    // gate. If the process dies before the health transition, boot observes
    // address B versus scope A and performs the same scrub before restoration.
    let ringWriteError: unknown = null;
    let ringFlushed = false;
    try {
      ApplicationSettings.setString(ADDRESS_KEYS.ring, normalized.ring);
      ringFlushed = ApplicationSettings.flush();
    } catch (error) {
      ringWriteError = error;
    }
    const ringReadback = normalizeMacAddress(
      ApplicationSettings.getString(ADDRESS_KEYS.ring, DEFAULT_DEVICE_ADDRESSES.ring),
    );
    // A write can update SharedPreferences' in-memory value even if its durable
    // flush reports failure. Once B is observable, always reset/scrub; never let
    // the live A communicator regain authority over persistence scoped to B.
    if (ringReadback === normalized.ring) {
      const transition = applyRingHealthIdentityChange(previousRing, normalized.ring);
      if (!transition.ok) {
        throw new Error(transition.error ?? "Could not establish the new ring health-data boundary.");
      }
    }
    if (ringWriteError || !ringFlushed || ringReadback !== normalized.ring) {
      throw new Error(`Could not durably save the ring address${ringWriteError ? `: ${String(ringWriteError)}` : "."}`);
    }
  }

  try {
    ApplicationSettings.setString(ADDRESS_KEYS.right, normalized.right);
    ApplicationSettings.setString(ADDRESS_KEYS.left, normalized.left);
    if (previousRing === normalized.ring) {
      ApplicationSettings.setString(ADDRESS_KEYS.ring, normalized.ring);
    }
    if (!ApplicationSettings.flush()) throw new Error("device-address flush failed");
  } catch (error) {
    throw new Error(`Could not durably save device addresses: ${String(error)}`);
  }
  const saved = loadDeviceAddresses();
  if (saved.right !== normalized.right || saved.left !== normalized.left || saved.ring !== normalized.ring) {
    throw new Error("Could not verify the saved device addresses.");
  }
  // A prior address-first transition may have left B durable while its health
  // scope failed. A same-address Save is an explicit repair opportunity.
  if (!isRingHealthPersistenceIdentityReady(normalized.ring)) {
    const repaired = bindRingHealthIdentityAtBoot(normalized.ring);
    if (!repaired.ok) {
      throw new Error(repaired.error ?? "Could not verify the configured ring health-data scope.");
    }
  }
}

export function normalizeMacAddress(value: string | null | undefined): string {
  const compact = (value ?? "")
    .trim()
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (compact.length !== 12) {
    return (value ?? "").trim().toUpperCase();
  }
  return compact.match(/.{1,2}/g)?.join(":") ?? compact;
}

export function isValidMacAddress(value: string, allowEmpty = false): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return allowEmpty;
  }
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(normalizeMacAddress(trimmed));
}
