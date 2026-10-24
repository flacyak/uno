/*
 * @fileoverview The record scanner of core/src/ingest/scan.ts in C for
 * WebAssembly with SIMD128. build.sh compiles it to scan.wasm.
 *
 * JS copies up to PIECE_BYTES of a chunk into `piece`, calls scan with the
 * state the last piece ended in, and reads the begins it wrote, as offsets
 * from the start of the piece. A record that begins at a CR ending the
 * previous piece is reported at offset -1. The state after the piece is
 * read back through `state`. JS holds each scanner's state, so one instance
 * serves every scanner.
 *
 * There are two kernels. scan is RecordScanner with its inner loops looking
 * 16 bytes at a time; every other state reads one byte. scan_blocks takes
 * 64 bytes at a time as bit masks of their LF, quote and CR bytes. Where
 * the rest of a block holds no quote and the scanner is between or inside
 * unquoted fields, every record in it starts one byte past an LF, so the
 * begins come straight from the masks. Elsewhere it steps the same state
 * machine, jumping from one masked byte to the next.
 */

#include <stdint.h>
#include <wasm_simd128.h>

enum {
  LINE = 0,
  LINE_CR = 1,
  FIELD = 2,
  BARE = 3,
  QUOTED = 4,
  QUOTE_SEEN = 5,
  QUOTE_CR = 6,
};

#define LF 0x0a
#define CR 0x0d
#define QUOTE 0x22
#define VECTOR_BYTES 16
/* Bytes scan_blocks takes at a time: one bit each in a uint64_t. */
#define BLOCK_BYTES 64
#define ALL_BITS (~(uint64_t)0)

/* The most bytes one call scans: small enough to stay in a core's L2. */
#define PIECE_BYTES (256 * 1024)
/* A record's first byte is followed by at least one more before the next
 * record can begin, so a piece holds at most half its length plus one. */
#define MAX_BEGINS (PIECE_BYTES / 2 + 1)

/* A block's worth of slack past the end, so the last block of a piece can
 * be loaded whole; the bytes past `end` are masked off. */
static uint8_t piece[PIECE_BYTES + BLOCK_BYTES];
static int32_t begins[MAX_BEGINS];
/* The state after the last scan. */
static int32_t state = LINE;

__attribute__((export_name("piece"))) uint8_t *piece_address(void) {
  return piece;
}

__attribute__((export_name("begins"))) int32_t *begins_address(void) {
  return begins;
}

__attribute__((export_name("pieceBytes"))) int32_t piece_bytes(void) {
  return PIECE_BYTES;
}

__attribute__((export_name("state"))) int32_t get_state(void) {
  return state;
}

/* find_line_or_quote is the offset of the first LF or quote from `from`,
 * or `end`. */
static int32_t find_line_or_quote(int32_t from, int32_t end) {
  const v128_t lf = wasm_i8x16_splat(LF);
  const v128_t quote = wasm_i8x16_splat(QUOTE);
  int32_t j = from;
  for (; j + VECTOR_BYTES <= end; j += VECTOR_BYTES) {
    const v128_t v = wasm_v128_load(piece + j);
    const uint32_t hits = wasm_i8x16_bitmask(
        wasm_v128_or(wasm_i8x16_eq(v, lf), wasm_i8x16_eq(v, quote)));
    if (hits != 0) return j + __builtin_ctz(hits);
  }
  for (; j < end; j++) {
    if (piece[j] == LF || piece[j] == QUOTE) return j;
  }
  return end;
}

/* find_quote is the offset of the first quote from `from`, or `end`. */
static int32_t find_quote(int32_t from, int32_t end) {
  const v128_t quote = wasm_i8x16_splat(QUOTE);
  int32_t j = from;
  for (; j + VECTOR_BYTES <= end; j += VECTOR_BYTES) {
    const v128_t v = wasm_v128_load(piece + j);
    const uint32_t hits = wasm_i8x16_bitmask(wasm_i8x16_eq(v, quote));
    if (hits != 0) return j + __builtin_ctz(hits);
  }
  for (; j < end; j++) {
    if (piece[j] == QUOTE) return j;
  }
  return end;
}

/* scan reads the first `end` bytes of `piece` from state `from` and returns
 * how many begins it wrote. */
__attribute__((export_name("scan"))) int32_t scan(int32_t end, int32_t sep,
                                                  int32_t from) {
  int32_t s = from;
  int32_t n = 0;
  int32_t i = 0;

  while (i < end) {
    const uint8_t b = piece[i];
    switch (s) {
      case LINE:
        if (b == LF) break;
        if (b == CR) {
          s = LINE_CR;
          break;
        }
        begins[n++] = i;
        s = b == QUOTE ? QUOTED : b == sep ? FIELD : BARE;
        break;

      case LINE_CR:
        if (b == LF) {
          s = LINE;
          break;
        }
        /* The CR is the byte before this one, perhaps in the last piece. */
        begins[n++] = i - 1;
        s = b == sep ? FIELD : BARE;
        break;

      case FIELD:
      case BARE: {
        const int32_t j = find_line_or_quote(i, end);
        if (j == end) {
          s = piece[end - 1] == sep ? FIELD : BARE;
          i = end;
          continue;
        }
        if (piece[j] == LF) s = LINE;
        else if (j == i ? s == FIELD : piece[j - 1] == sep) s = QUOTED;
        else s = BARE;
        i = j;
        break;
      }

      case QUOTED: {
        const int32_t j = find_quote(i, end);
        if (j == end) {
          i = end;
          continue;
        }
        s = QUOTE_SEEN;
        i = j;
        break;
      }

      case QUOTE_SEEN:
        if (b == QUOTE) s = QUOTED;
        else if (b == sep) s = FIELD;
        else if (b == LF) s = LINE;
        else if (b == CR) s = QUOTE_CR;
        else s = QUOTED;
        break;

      case QUOTE_CR:
        if (b == LF) s = LINE;
        else s = b == QUOTE ? QUOTE_SEEN : QUOTED;
        break;

      default:
        __builtin_trap();
    }
    i++;
  }

  state = s;
  return n;
}

/* mask_of has bit k set when byte k of the 64 at `at` equals `c`. */
static uint64_t mask_of(const uint8_t *at, v128_t c) {
  uint64_t mask = 0;
  for (int32_t v = 0; v < BLOCK_BYTES / VECTOR_BYTES; v++) {
    const v128_t bytes = wasm_v128_load(at + v * VECTOR_BYTES);
    const uint64_t bits = wasm_i8x16_bitmask(wasm_i8x16_eq(bytes, c));
    mask |= bits << (v * VECTOR_BYTES);
  }
  return mask;
}

/* scan_blocks is scan, 64 bytes at a time: same arguments, same results. */
__attribute__((export_name("scanBlocks"))) int32_t scan_blocks(int32_t end,
                                                               int32_t sep,
                                                               int32_t from) {
  const v128_t lf_bytes = wasm_i8x16_splat(LF);
  const v128_t quote_bytes = wasm_i8x16_splat(QUOTE);
  const v128_t cr_bytes = wasm_i8x16_splat(CR);
  int32_t s = from;
  int32_t n = 0;

  for (int32_t base = 0; base < end; base += BLOCK_BYTES) {
    const uint8_t *p = piece + base;
    const int32_t stop = end - base < BLOCK_BYTES ? end - base : BLOCK_BYTES;
    const uint64_t valid =
        ALL_BITS;
    const uint64_t lf = mask_of(p, lf_bytes) & valid;
    const uint64_t quote = mask_of(p, quote_bytes) & valid;
    const uint64_t cr = mask_of(p, cr_bytes) & valid;
    const uint8_t last = p[stop - 1];

    // k is the next byte of the block to read.
    int32_t k = 0;
    while (k < stop) {
      const uint64_t rest = valid & (ALL_BITS << k);

      if ((s == LINE || s == FIELD || s == BARE) && (quote & rest) == 0) {
        // No quote from here to the end of the block, so a record begins
        // at every byte after an LF that is not itself an LF, and at byte k
        // if the scanner is between records. A CR there may be a blank
        // line, which the state machine below decides.
        const uint64_t at_k = s == LINE ? (uint64_t)1 << k : 0;
        uint64_t starts = ((lf << 1) | at_k) & rest & ~lf;
        if ((starts & cr) == 0) {
          for (; starts != 0; starts &= starts - 1) {
            begins[n++] = base + __builtin_ctzll(starts);
          }
          s = last == LF ? LINE : last == sep ? FIELD : BARE;
          k = stop;
          continue;
        }
      }

      const uint8_t b = p[k];
      switch (s) {
        case LINE:
          if (b == LF) break;
          if (b == CR) {
            s = LINE_CR;
            break;
          }
          begins[n++] = base + k;
          s = b == QUOTE ? QUOTED : b == sep ? FIELD : BARE;
          break;

        case LINE_CR:
          if (b == LF) {
            s = LINE;
            break;
          }
          begins[n++] = base + k - 1;
          s = b == sep ? FIELD : BARE;
          break;

        case FIELD:
        case BARE: {
          const uint64_t hits = (lf | quote) & rest;
          if (hits == 0) {
            s = last == sep ? FIELD : BARE;
            k = stop;
            continue;
          }
          const int32_t j = __builtin_ctzll(hits);
          if (p[j] == LF) s = LINE;
          else if (j == k ? s == FIELD : p[j - 1] == sep) s = QUOTED;
          else s = BARE;
          k = j;
          break;
        }

        case QUOTED: {
          const uint64_t hits = quote & rest;
          if (hits == 0) {
            k = stop;
            continue;
          }
          s = QUOTE_SEEN;
          k = __builtin_ctzll(hits);
          break;
        }

        case QUOTE_SEEN:
          if (b == QUOTE) s = QUOTED;
          else if (b == sep) s = FIELD;
          else if (b == LF) s = LINE;
          else if (b == CR) s = QUOTE_CR;
          else s = QUOTED;
          break;

        case QUOTE_CR:
          if (b == LF) s = LINE;
          else s = b == QUOTE ? QUOTE_SEEN : QUOTED;
          break;

        default:
          __builtin_trap();
      }
      k++;
    }
  }

  state = s;
  return n;
}
