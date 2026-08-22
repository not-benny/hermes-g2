#ifndef CFW_SAFETY_H
#define CFW_SAFETY_H

#include <stdint.h>

/* Overflow-safe validation for a row-major byte region inside an input buffer. */
static inline int cfw_bmp_pixel_region_fits(
    uint32_t data_offset,
    uint32_t stride,
    uint32_t height,
    uint32_t input_length
) {
    if (data_offset > input_length || stride == 0u || height == 0u) return 0;
    uint32_t available = input_length - data_offset;
    if (height > available / stride) return 0;
    return stride * height <= available;
}

/* Convert a signed BMP height without triggering -INT32_MIN undefined behavior. */
static inline int cfw_abs_bmp_height(int32_t raw_height, uint32_t *height_out) {
    if (height_out == 0 || raw_height == INT32_MIN) return 0;
    *height_out = raw_height < 0 ? (uint32_t)(-raw_height) : (uint32_t)raw_height;
    return 1;
}

/* Overflow-safe capacity check for appending bytes to a fixed buffer. */
static inline int cfw_append_fits(
    uint32_t current_length,
    uint32_t capacity,
    uint32_t bytes_written
) {
    return current_length <= capacity && bytes_written <= capacity - current_length;
}

#endif
