#!/usr/bin/env bash
# @fileoverview Compiles scan.c to scan.wasm with zig's bundled clang and
# wasm-ld: wasm32, SIMD128 on, no libc, no entry point. Run from anywhere.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
zig cc \
  -target wasm32-freestanding \
  -mcpu=generic+simd128 \
  -O3 \
  -nostdlib \
  -Wall -Wextra -Werror \
  -Wl,--no-entry \
  -o "$here/scan.wasm" \
  "$here/scan.c"
