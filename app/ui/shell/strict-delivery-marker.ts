// Shell color-key surfaces reserve 0 for transparency and use 1 for opaque
// black. Native's 8bpp -> 4bpp packer maps 1 to wire shade 0 and 8 to wire
// shade 1, so these two values force distinct physical frames while remaining
// effectively black in the extreme corner of the lens.
const WIRE_BLACK_GRAY = 1;
const WIRE_DIM_GRAY = 8;

/** Alternate one lens pixel across distinct 4bpp wire shades for strict ACKs. */
export function strictDeliveryMarkerGray(deliveryNonce: number): number {
  return (deliveryNonce & 1) === 0 ? WIRE_BLACK_GRAY : WIRE_DIM_GRAY;
}
