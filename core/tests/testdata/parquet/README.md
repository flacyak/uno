# Parquet files from apache/parquet-testing

These files are copied unchanged from [apache/parquet-testing](https://github.com/apache/parquet-testing) at commit `eedfad3f086678d282a00d8ff3cf8932d5d29af5`.
They are licensed under the Apache License 2.0, in `LICENSE.txt` beside them.
The repository has no NOTICE file at that commit.

`shredded_variant/case-001.parquet` comes from the repository's `shredded_variant` folder, and every other file from its `data` folder.

## What each file covers

| file                                                 | what it covers                                         |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `alltypes_plain.parquet`                             | every plain type, INT96 timestamps, uncompressed pages |
| `alltypes_plain.snappy.parquet`                      | the same, with snappy pages                            |
| `alltypes_dictionary.parquet`                        | the same, dictionary encoded                           |
| `binary.parquet`                                     | the bytes 0 to 11, which are control characters        |
| `byte_array_decimal.parquet`                         | a decimal stored as variable-length bytes              |
| `byte_stream_split.zstd.parquet`                     | floats split by byte, in zstd pages                    |
| `concatenated_gzip_members.parquet`                  | a gzip page of several members, unsigned 64-bit values |
| `data_index_bloom_encoding_stats.parquet`            | gzip pages with an offset index                        |
| `datapage_v2.snappy.parquet`                         | version 2 data pages and a list                        |
| `fixed_length_decimal.parquet`                       | a decimal stored as fixed-length bytes                 |
| `fixed_length_decimal_legacy.parquet`                | the same, as an older writer annotates it              |
| `float16_nonzeros_and_nans.parquet`                  | half-precision floats, NaN among them                  |
| `int32_decimal.parquet`                              | a decimal stored as an INT32                           |
| `int32_with_null_pages.parquet`                      | 1,000 rows over many pages, with an offset index       |
| `int64_decimal.parquet`                              | a decimal stored as an INT64                           |
| `int96_from_spark.parquet`                           | INT96 timestamps past what a Date holds                |
| `map_no_value.parquet`                               | maps with and without values, and a list               |
| `nested_lists.snappy.parquet`                        | lists three deep                                       |
| `nested_maps.snappy.parquet`                         | maps keyed by strings, holding maps                    |
| `nonnullable.impala.parquet`                         | structs, lists and maps nested in each other           |
| `null_list.parquet`                                  | an empty list                                          |
| `nulls.snappy.parquet`                               | a struct whose field is always null                    |
| `repeated_no_annotation.parquet`                     | a repeated group with no LIST annotation               |
| `single_nan.parquet`                                 | a double that is NaN                                   |
| `unknown-logical-type.parquet`                       | an annotation newer than hyparquet                     |
| `large_string_map.brotli.parquet`                    | Brotli pages, refused                                  |
| `lz4_raw_compressed.parquet`                         | LZ4 pages, refused                                     |
| `hadoop_lz4_compressed.parquet`                      | Hadoop's LZ4 pages, refused                            |
| `bson.parquet`                                       | a BSON column, refused                                 |
| `shredded_variant/case-001.parquet`                  | a VARIANT column, refused                              |
| `encrypt_columns_and_footer.parquet.encrypted`       | an encrypted footer, refused                           |
| `encrypt_columns_plaintext_footer.parquet.encrypted` | encrypted columns under a plain footer, refused        |
