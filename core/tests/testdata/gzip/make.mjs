/**
 * @fileoverview Writes the gzip fixtures beside it from the CSV fixtures one
 * folder up, the same bytes on every run.
 *
 * Usage: node make.mjs
 *
 * - sales-q3.csv.gz is one member.
 * - stored.gz is two parts around a slab of noise, in blocks of about a
 *   thousand symbols. The noise is kept in stored blocks, and the text's
 *   blocks start part way into a byte, at odd bits as well as even ones.
 * - members.csv.gz is the three parts of sales-q3.csv as members of their
 *   own, with an empty member after the first.
 * - bgzf.csv.gz is sales-q3.csv in BGZF blocks, ending in the empty block
 *   BGZF closes a file with.
 * - empty.gz is one empty member.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

/** The most data bytes bgzip puts in one block. */
const BGZF_BLOCK_DATA = 0xff00;
/** The bytes of noise between the two parts in stored.gz. */
const NOISE_BYTES = 40 << 10;
/** zlib's memLevel for blocks of about a thousand symbols. */
const SMALL_BLOCKS = 4;
/**
 * The header of a BGZF block up to its size: gzip with FEXTRA, and one
 * extra field, BC, two bytes long.
 */
const BGZF_HEAD = [31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0];
/** The bytes of a BGZF block's size, and of its trailer's CRC and length. */
const SIZE_BYTES = 2;
const CRC_BYTES = 4;
const LENGTH_BYTES = 4;
/** The bytes around a BGZF block's deflate data. */
const BGZF_FRAME = BGZF_HEAD.length + SIZE_BYTES + CRC_BYTES + LENGTH_BYTES;

/**
 * The bytes of a fixture one folder up.
 * @param {string} name
 * @return {Buffer}
 */
function fixture(name) {
  return readFileSync(new URL(`../${name}`, import.meta.url));
}

/**
 * Bytes that look random, the same on every run for a seed.
 * @param {string} seed
 * @param {number} length
 * @return {Buffer}
 */
function noise(seed, length) {
  return createHash('shake256', { outputLength: length }).update(seed).digest();
}

/**
 * One BGZF block: a gzip member whose extra field says its size.
 * @param {Buffer} data
 * @return {Buffer}
 */
function bgzfBlock(data) {
  const deflated = deflateRawSync(data);
  const block = Buffer.alloc(BGZF_FRAME + deflated.length);
  block.set(BGZF_HEAD);
  // BSIZE, the block's size less one.
  block.writeUInt16LE(block.length - 1, BGZF_HEAD.length);
  block.set(deflated, BGZF_HEAD.length + SIZE_BYTES);
  block.writeUInt32LE(crc32(data), block.length - CRC_BYTES - LENGTH_BYTES);
  block.writeUInt32LE(data.length, block.length - LENGTH_BYTES);
  return block;
}

/**
 * Data cut into BGZF blocks, then the empty block that ends a file.
 * @param {Buffer} data
 * @return {Buffer}
 */
function bgzf(data) {
  const blocks = [];
  for (let at = 0; at < data.length; at += BGZF_BLOCK_DATA) {
    blocks.push(bgzfBlock(data.subarray(at, at + BGZF_BLOCK_DATA)));
  }
  blocks.push(bgzfBlock(Buffer.alloc(0)));
  return Buffer.concat(blocks);
}

const csv = fixture('sales-q3.csv');
const parts = [1, 2, 3].map((n) => fixture(`sales-q3-part-${n}.csv`));
const empty = gzipSync(Buffer.alloc(0));
const files = {
  'sales-q3.csv.gz': gzipSync(csv, { level: 9 }),
  'stored.gz': gzipSync(
    Buffer.concat([parts[0], noise('noise', NOISE_BYTES), parts[1]]),
    { memLevel: SMALL_BLOCKS },
  ),
  'members.csv.gz': Buffer.concat([
    gzipSync(parts[0]),
    empty,
    gzipSync(parts[1]),
    gzipSync(parts[2]),
  ]),
  'bgzf.csv.gz': bgzf(csv),
  'empty.gz': empty,
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(new URL(name, import.meta.url), bytes);
}
