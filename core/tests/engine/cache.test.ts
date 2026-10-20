/**
 * @fileoverview The block cache on its own: what it holds, what each block
 * costs it, and which block goes first once the budget is passed.
 */

import { expect, test } from 'vite-plus/test';

import { BlockCache } from '@engine/rows';

/** A budget that holds three blocks of BLOCK_COST. */
const BUDGET = 300;
/** What one ordinary block costs. */
const BLOCK_COST = 100;

/** recordsOf is one block of one row whose one cell names the block. */
function recordsOf(block: number): string[][] {
  return [[`block ${block}`]];
}

/** filled is a cache holding blocks 0, 1 and 2, oldest first. */
function filled(): BlockCache {
  const cache = new BlockCache(BUDGET);
  for (const block of [0, 1, 2]) {
    cache.put(block, recordsOf(block), BLOCK_COST);
  }
  return cache;
}

/**
 * heldOf lists which of `blocks` the cache holds. Each one held becomes the
 * newest use, in the order listed.
 */
function heldOf(cache: BlockCache, blocks: number[]): number[] {
  return blocks.filter((block) => cache.get(block) !== undefined);
}

test('a block is held at the cost it was put with', () => {
  const cache = filled();
  expect(cache.held).toBe(BUDGET);
  expect(cache.get(1)).toEqual(recordsOf(1));
  expect(cache.get(3)).toBeUndefined();
});

test('the block used least recently goes first', () => {
  const cache = filled();
  cache.get(0);
  cache.put(3, recordsOf(3), BLOCK_COST);
  expect(heldOf(cache, [0, 1, 2, 3])).toEqual([0, 2, 3]);
  expect(cache.held).toBe(BUDGET);
});

test('a costly block pushes out as many old ones as its cost needs', () => {
  const cache = filled();
  cache.put(3, recordsOf(3), 2 * BLOCK_COST);
  expect(heldOf(cache, [0, 1, 2, 3])).toEqual([2, 3]);
  expect(cache.held).toBe(BUDGET);
});

test('a block costing more than the budget is held alone, until the next', () => {
  const cache = filled();
  cache.put(3, recordsOf(3), 2 * BUDGET);
  expect(heldOf(cache, [0, 1, 2, 3])).toEqual([3]);
  expect(cache.held).toBe(2 * BUDGET);
  cache.put(4, recordsOf(4), BLOCK_COST);
  expect(heldOf(cache, [3, 4])).toEqual([4]);
  expect(cache.held).toBe(BLOCK_COST);
});
