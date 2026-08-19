// CFW capability advertisement and Faceclaw wake-takeover lease.
//
// Appends one extra protobuf field to the sid=0x09 device-settings READ response
// (G2SettingPackage) right before it is framed and sent, so a connected app can
// detect this custom firmware and discover which extensions it supports without
// any timeout-based probing. The field is:
//
//   field 100, wire type 2 (length-delimited string):
//     "EVENCFW/<ver> <space-separated feature tokens>"
//
// Tag 100 is far above the stock message's fields (1..19), so stock decoders and
// the phone bridge skip it as an unknown field -- fully backward compatible.
//
// HOOK: the settings responder FUN_004b42b4 ends with
//     r0=type(1) r1=sid(9) r2=buf r3=len ; bl FUN_00475b14   ; aa21 send
// We retarget that one `bl` to settings_send_wrapper. The 4 send args are already
// in r0..r3, so the wrapper appends to `buf` (a 256-byte static response buffer
// at 0x20071080 that only uses ~40 B) and tail-calls the real sender with the
// grown length. Only this call site is redirected, but we still guard on sid==9.

// The same sid remains subscribed while EvenHub is shut down, so field 101 is
// also used for a private control message:
//
//   field 101 bytes = ['F','C',version=1,op,nonceLo,nonceHi]
//     op 1 ACQUIRE/RENEW  -- arm a volatile 90-second lease
//     op 2 RELEASE        -- clear the lease; launch a pending dashboard now
//     op 3 WAKE_CLAIM     -- phone saw our wake notify; extend fallback to 5s
//     op 4 WAKE_READY     -- EvenHub frame is ready; cancel the fallback
//     op 5 FB_ACQUIRE      -- arm/renew a separate 90-second direct-framebuffer lease
//     op 6 FB_RELEASE      -- release that lease and restore stock compositor repaints
//     op 7 WEAR_QUERY      -- emit the current stock wear state on sid 0x10
//
// A deferred double tap is reported to the phone as field 102:
//
//   field 102 bytes = ['F','C',version=1,event=1,nonceLo,nonceHi]
//
// Both are unknown fields to stock protobuf decoders and are therefore ignored
// by the official app and unmodified firmware.

typedef int  (*send_fn)(int type, int sid, unsigned char *buf, unsigned len);
typedef int  (*pb_decode_fn)(void *stream, const void *fields, void *dest);
typedef void (*display_start_fn)(unsigned app_id, void *arg, unsigned arg_len, void *cb);

#define FW_SEND 0x004768d9 /* FUN_00475b14 | thumb bit */
#define FW_NOTIFY_SEND 0x004769dfu /* FUN_00475c1a | thumb bit */
#define FW_PB_DECODE ((pb_decode_fn)0x00491895u)       /* FUN_00490120 */
#define FW_DISPLAY_START ((display_start_fn)0x00464f0fu) /* FUN_00464b2e */
#define FW_SIDE_ID ((lens_side_fn)0x0045a891u)         /* 1=right, 2=left */
typedef unsigned (*wear_status_fn)(void);
#define FW_WEAR_STATUS ((wear_status_fn)0x004a0303u)   /* cached WearDetect status: 1=off, 2=on */

#define FACECLAW_PROTO_VERSION 1u
#define FACECLAW_CONTROL_FIELD 101u
#define FACECLAW_EVENT_FIELD   102u
#define FACECLAW_OP_ACQUIRE    1u
#define FACECLAW_OP_RELEASE    2u
#define FACECLAW_OP_CLAIM      3u
#define FACECLAW_OP_READY      4u
#define FACECLAW_OP_FB_ACQUIRE 5u
#define FACECLAW_OP_FB_RELEASE 6u
#define FACECLAW_OP_WEAR_QUERY 7u
#define FACECLAW_EVENT_WAKE    1u
#define FACECLAW_LEASE_MS      90000u
#define FACECLAW_FALLBACK_MS   400u
#define FACECLAW_CLAIMED_MS    5000u
#define SETTINGS_RESPONSE_CAPACITY 256u

static customCfwContext *faceclaw_context_if_valid(void) {
    customCfwContext *ctx = *(customCfwContext **)CFW_CTX_SLOT;
    if (((uintptr_t)ctx & 3u) != 0 ||
        (uintptr_t)ctx - 0x20000000u >= 0x00800000u) return 0;
    return ctx->magic == CFW_CTX_MAGIC ? ctx : 0;
}

/* Signed subtraction is wrap-safe because every lease is less than 2^31 ms. */
static int wake_lease_active_locked(customCfwContext *ctx) {
    if (ctx->wake_lease_deadline == 0) return 0;
    if ((int32_t)(ctx->wake_lease_deadline - FW_MS_TICK) <= 0) {
        ctx->wake_lease_deadline = 0;
        return 0;
    }
    return 1;
}

__attribute__((used, noinline))
int cfw_wake_lease_active(void) {
    customCfwContext *ctx = faceclaw_context_if_valid();
    if (!ctx || !cfw_mutex_lock(ctx->timer_mutex)) return 0;
    int active = wake_lease_active_locked(ctx);
    cfw_mutex_unlock(ctx->timer_mutex);
    return active;
}

/* Caller holds timer_mutex. Return whether this path atomically won launch. */
static int faceclaw_claim_launch_locked(customCfwContext *ctx) {
    if (!ctx->wake_dashboard_pending) return 0;
    ctx->wake_dashboard_pending = 0;
    ctx->wake_nonce = 0;
    if (ctx->wake_fallback_timer) (void)FW_TIMER_STOP(ctx->wake_fallback_timer);
    return 1;
}

void faceclaw_wake_fallback_tick(void *arg) {
    customCfwContext *ctx = (customCfwContext *)arg;
    if (!ctx || ctx->magic != CFW_CTX_MAGIC || !cfw_mutex_lock(ctx->timer_mutex)) return;
    int launch = faceclaw_claim_launch_locked(ctx);
    cfw_mutex_unlock(ctx->timer_mutex);
    if (launch) FW_DISPLAY_START(1, 0, 0, 0);
}

/* Caller holds timer_mutex so callback/handler stop-start side effects serialize. */
static int faceclaw_arm_fallback_locked(customCfwContext *ctx, uint32_t delay_ms) {
    if (ctx->wake_fallback_timer == 0)
        ctx->wake_fallback_timer =
            FW_TIMER_NEW((void *)&faceclaw_wake_fallback_tick, 0, ctx, 0);
    if (ctx->wake_fallback_timer == 0) return 0;
    (void)FW_TIMER_STOP(ctx->wake_fallback_timer);
    return FW_TIMER_START(ctx->wake_fallback_timer, delay_ms) == 0;
}

/* Caller holds timer_mutex through FW_SEND because sender copy lifetime is opaque. */
static void faceclaw_send_wake_event_locked(customCfwContext *ctx) {
    if (FW_SIDE_ID() != 1) return;
    unsigned char *p = ctx->wake_notify_buf;
    p[0] = 0x08; p[1] = 0x03;
    p[2] = 0x10; p[3] = 0x00;
    p[4] = 0xb2; p[5] = 0x06; p[6] = 0x06;
    p[7] = 'F'; p[8] = 'C';
    p[9] = FACECLAW_PROTO_VERSION;
    p[10] = FACECLAW_EVENT_WAKE;
    p[11] = (unsigned char)ctx->wake_nonce;
    p[12] = (unsigned char)(ctx->wake_nonce >> 8);
    ((send_fn)FW_SEND)(1, 9, p, 13);
}

/* Send the stock OnboardingDataPackage EVENT/GLS_WEAR_STATUS wire shape
 * directly. The stock helper first checks the running app id and then routes
 * through onboarding's encoder state; using the generic notify sender removes
 * both lifecycle dependencies while retaining its right-arm/BLE guards.
 *
 *   field 1 commandId=3 (EVENT)
 *   field 2 magic=0
 *   field 5 { field 1 event=1, field 2 eventParam=wearing }
 */
__attribute__((used, noinline))
void faceclaw_send_wear_event(unsigned wearing) {
    customCfwContext *ctx = getCustomCfwContext();
    if (!ctx) return;
    unsigned char *p = ctx->wear_notify_buf;
    p[0] = 0x08; p[1] = 0x03;
    p[2] = 0x10; p[3] = 0x00;
    p[4] = 0x2a; p[5] = 0x04;
    p[6] = 0x08; p[7] = 0x01;
    p[8] = 0x10; p[9] = wearing ? 1u : 0u;
    ((send_fn)FW_NOTIFY_SEND)(1, 0x10, p, 10);
}

/* Replaces only the two dashboard-start BLs in the idle double-click policy.
 * Every competing launch path claims pending under timer_mutex and launches only
 * after unlock, so fallback/second-tap/RELEASE can produce at most one launch. */
void faceclaw_display_start(unsigned app_id, void *arg, unsigned arg_len, void *cb) {
    customCfwContext *ctx = faceclaw_context_if_valid();
    if (app_id != 1 || ctx == 0 || !cfw_mutex_lock(ctx->timer_mutex)) {
        FW_DISPLAY_START(app_id, arg, arg_len, cb);
        return;
    }
    if (!wake_lease_active_locked(ctx)) {
        cfw_mutex_unlock(ctx->timer_mutex);
        FW_DISPLAY_START(app_id, arg, arg_len, cb);
        return;
    }

    int launch = 0;
    if (ctx->wake_dashboard_pending) {
        launch = faceclaw_claim_launch_locked(ctx);       /* second-tap override */
    } else {
        uint16_t nonce = (uint16_t)(ctx->wake_nonce + 1u);
        if (nonce == 0) nonce = 1;
        ctx->wake_nonce = nonce;
        ctx->wake_dashboard_pending = 1;
        if (!faceclaw_arm_fallback_locked(ctx, FACECLAW_FALLBACK_MS))
            launch = faceclaw_claim_launch_locked(ctx);   /* fail open */
        else
            faceclaw_send_wake_event_locked(ctx);
    }
    cfw_mutex_unlock(ctx->timer_mutex);
    if (launch) FW_DISPLAY_START(1, 0, 0, 0);
}

static int faceclaw_read_varint(
    const uint8_t **cursor, const uint8_t *end, uint32_t *value
) {
    uint32_t out = 0;
    uint32_t shift = 0;
    const uint8_t *p = *cursor;
    while (p < end && shift < 32) {
        uint8_t byte = *p++;
        out |= (uint32_t)(byte & 0x7fu) << shift;
        if ((byte & 0x80u) == 0) {
            *cursor = p;
            *value = out;
            return 1;
        }
        shift += 7;
    }
    return 0;
}

static void faceclaw_apply_control(const uint8_t *data, uint32_t len) {
    if (len < 6 || data[0] != 'F' || data[1] != 'C' ||
        data[2] != FACECLAW_PROTO_VERSION) return;
    customCfwContext *ctx = getCustomCfwContext();
    if (!ctx) return;
    uint8_t op = data[3];
    uint16_t nonce = (uint16_t)data[4] | ((uint16_t)data[5] << 8);
    if (op == FACECLAW_OP_WEAR_QUERY) {
        unsigned status = FW_WEAR_STATUS();
        if (status == 1u || status == 2u)
            faceclaw_send_wear_event(status == 2u ? 1u : 0u);
        return;
    }
    if (!cfw_mutex_lock(ctx->timer_mutex)) return;
    int launch = 0;
    if (op == FACECLAW_OP_ACQUIRE) {
        ctx->wake_lease_deadline = FW_MS_TICK + FACECLAW_LEASE_MS;
    } else if (op == FACECLAW_OP_RELEASE) {
        ctx->wake_lease_deadline = 0;
        launch = faceclaw_claim_launch_locked(ctx);
    } else if (op == FACECLAW_OP_CLAIM) {
        if (wake_lease_active_locked(ctx) && ctx->wake_dashboard_pending) {
            ctx->wake_nonce = nonce;
            if (!faceclaw_arm_fallback_locked(ctx, FACECLAW_CLAIMED_MS))
                launch = faceclaw_claim_launch_locked(ctx); /* rearm failure: fail open */
        }
    } else if (op == FACECLAW_OP_READY) {
        if (wake_lease_active_locked(ctx) && ctx->wake_dashboard_pending &&
            ctx->wake_nonce == nonce) {
            ctx->wake_dashboard_pending = 0;
            ctx->wake_nonce = 0;
            if (ctx->wake_fallback_timer) (void)FW_TIMER_STOP(ctx->wake_fallback_timer);
        }
    } else if (op == FACECLAW_OP_FB_ACQUIRE) {
        if (ctx->direct_lease_deadline == 0 ||
            (int32_t)(ctx->direct_lease_deadline - FW_MS_TICK) <= 0) {
            ctx->direct_active = 0;
        }
        ctx->direct_lease_deadline = FW_MS_TICK + FACECLAW_LEASE_MS;
    } else if (op == FACECLAW_OP_FB_RELEASE) {
        ctx->direct_lease_deadline = 0;
        ctx->direct_active = 0;
    }
    cfw_mutex_unlock(ctx->timer_mutex);
    if (launch) FW_DISPLAY_START(1, 0, 0, 0);
}

static void faceclaw_scan_settings_control(const uint8_t *buf, uint32_t len) {
    const uint8_t *p = buf;
    const uint8_t *end = buf + len;
    while (p < end) {
        uint32_t key;
        if (!faceclaw_read_varint(&p, end, &key)) return;
        uint32_t field = key >> 3;
        uint32_t wire = key & 7u;
        if (wire == 0) {
            uint32_t ignored;
            if (!faceclaw_read_varint(&p, end, &ignored)) return;
        } else if (wire == 1) {
            if ((uint32_t)(end - p) < 8) return;
            p += 8;
        } else if (wire == 2) {
            uint32_t item_len;
            if (!faceclaw_read_varint(&p, end, &item_len) ||
                item_len > (uint32_t)(end - p)) return;
            if (field == FACECLAW_CONTROL_FIELD)
                faceclaw_apply_control(p, item_len);
            p += item_len;
        } else if (wire == 5) {
            if ((uint32_t)(end - p) < 4) return;
            p += 4;
        } else {
            return;
        }
    }
}

/* Wrap nanopb's decoder at the sid-0x09 service call site. pb_istream_t is
 * {callback,state,bytes_left,errmsg}; state is the original byte buffer. Scan
 * before nanopb advances the stream, then let the stock decoder/handler see
 * the unchanged package. */
int settings_decode_wrapper(void *stream, const void *fields, void *dest) {
    uint32_t *words = (uint32_t *)stream;
    const uint8_t *buf = (const uint8_t *)words[1];
    uint32_t len = words[2];
    if (buf && len) faceclaw_scan_settings_control(buf, len);
    return FW_PB_DECODE(stream, fields, dest);
}

/* Entry trampoline for even_ai_display_ctrl. The first four stock bytes
 * (`push {r0-r6,lr}; mov r6,r0`) are replaced by a B.W here. Reproduce them,
 * suppress only START while a valid Faceclaw lease exists, and otherwise
 * resume the stock function at 0x004e6a92 with every argument restored. */
__attribute__((naked))
void faceclaw_evenai_display_entry(void) {
    __asm volatile(
        "push {r0-r6, lr}\n"
        "mov r6, r0\n"
        "cmp r0, #0\n"
        "bne 1f\n"
        "bl cfw_wake_lease_active\n"
        "cmp r0, #0\n"
        "bne 2f\n"
        "ldmia sp, {r0-r3}\n"
        "mov r6, r0\n"
        "1:\n"
        "movw r12, #0x6a93\n"   /* 0x004e6a92 | Thumb bit; BX needs bit 0 set */
        "movt r12, #0x004e\n"
        "bx r12\n"
        "2:\n"
        "pop {r0-r6, pc}\n"
    );
}

// Capability string "EVENCFW/<ver> <space-separated feature tokens>":
//   EVENCFW/9  -> contract with RTOS-safe image/timer/container lifecycle handling
//   img576     -> 576x288 image containers (vs stock 288x144 cap)
//   imgz       -> zlib (DEFLATE) compressed image payloads
//   rle        -> compact run-length encoded delta rows
//   wakelease  -> fail-open Faceclaw ownership of idle wakes / local Even AI
//   directfb   -> bypass LVGL and copy the packed shadow into the panel framebuffer
//   img640     -> modes 3/6/8/9 use the full 640x480 panel independent of the carrier
//   fbguard    -> preserve direct frames across stock widget repaints under a fail-open lease
//   wearnotify -> lifecycle-independent wear events + private current-state query
//   compass10  -> mode 10 controls the stock compass and its navigation notifications
//
// The string is a normal rodata literal now that build.py emits/relocates .rodata
// (earlier this had to be spelled out byte-by-byte to avoid a rodata section). strlcpy
// comes from zlib_glue.c, which shares this translation unit via patches_main.c.
int settings_send_wrapper(int type, int sid, unsigned char *buf, unsigned len) {
    if (sid == 9) {
        static const char caps[] = "EVENCFW/9 img576 img640 imgz rle wakelease directfb fbguard wearnotify compass10";
        /* sizeof(caps) includes strlcpy's terminating NUL. The NUL is not
         * transmitted, but it still must fit in the stock 256-byte buffer. */
        if (cfw_append_fits(len, SETTINGS_RESPONSE_CAPACITY, 3u + sizeof(caps))) {
            unsigned char *p = buf + len;
            p[0] = 0xA2; p[1] = 0x06;                      // field 100, wire type 2: tag 802
            unsigned clen = strlcpy((char *)(p + 3), caps, sizeof(caps));
            p[2] = (unsigned char)clen;                    // length-delimited payload length
            len += 3 + clen;
        }
    }
    return ((send_fn)FW_SEND)(type, sid, buf, len);
}
