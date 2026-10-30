/**
 * @fileoverview The codecs Parquet pages are read through, and what each
 * codec a footer can name is to uno: one it reads, or a feature it refuses
 * by name.
 *
 * hyparquet decodes snappy itself. A gzip page goes through the core's own
 * gunzipWhole and a zstd page through fzstd, so no codec compiles WASM.
 */

import { decompress } from 'fzstd';
import type { CompressionCodec, Compressors } from 'hyparquet/src/index.js';

import { Refusal } from '@said';
import type { ParquetCodec, ParquetFeature } from '@said';

import { gunzipWhole } from '../gzip.ts';

/**
 * The decompressors hyparquet is handed, for the codecs it has none of its
 * own for. Each takes every gzip member or zstd frame of a page.
 */
export const COMPRESSORS: Compressors = {
  GZIP: (page) => gunzipWhole(page),
  ZSTD: (page) => decompress(page),
};

/** Every codec uno reads, in the order a label names them. */
export const CODECS: readonly ParquetCodec[] = [
  'uncompressed',
  'snappy',
  'gzip',
  'zstd',
];

/** What a codec is to uno: one it reads, or a feature it refuses. */
type CodecUse =
  | { readonly reads: ParquetCodec }
  | { readonly refuses: ParquetFeature };

/**
 * What each codec a footer can name is to uno. A hyparquet that names
 * another fails to compile here.
 */
const USES: Readonly<Record<CompressionCodec, CodecUse>> = {
  UNCOMPRESSED: { reads: 'uncompressed' },
  SNAPPY: { reads: 'snappy' },
  GZIP: { reads: 'gzip' },
  ZSTD: { reads: 'zstd' },
  BROTLI: { refuses: 'brotli' },
  LZ4: { refuses: 'lz4' },
  LZ4_RAW: { refuses: 'lz4' },
  LZO: { refuses: 'lzo' },
};

/**
 * codecOf is the codec uno reads the pages of a column chunk in `name`
 * through. A codec it does not read is refused as parquet-unsupported, and a
 * chunk that names none it knows as parquet-broken.
 */
export function codecOf(
  name: string,
  codec: CompressionCodec | undefined,
): ParquetCodec {
  const use = codec === undefined ? undefined : USES[codec];
  if (use === undefined) throw new Refusal({ t: 'parquet-broken', name });
  if ('refuses' in use) {
    throw new Refusal({ t: 'parquet-unsupported', name, feature: use.refuses });
  }
  return use.reads;
}
