/**
 * @fileoverview A Refusal is the Error the engine throws when it will not do
 * what was asked, and an Effect tagged error an Effect fails with.
 */

import { Effect } from 'effect';
import { describe, expect, test } from 'vite-plus/test';

import { Refusal, english, saidOf } from '@said';
import type { Said } from '@said';

const SAID: Said = { t: 'file-closed' };

describe('a refusal', () => {
  test('is an Error named Refusal whose message is its sentence', () => {
    const refusal = new Refusal(SAID);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('Refusal');
    expect(refusal.message).toBe(english(SAID));
    expect(saidOf(refusal)).toEqual(SAID);
  });

  test('fails an Effect that yields it, and is caught by its tag as itself', async () => {
    const program = Effect.gen(function* () {
      yield* new Refusal(SAID);
      return 'done';
    }).pipe(
      Effect.catchTag('Refusal', (refusal) =>
        Effect.succeed(`refused: ${english(refusal.said)}`),
      ),
    );
    expect(await Effect.runPromise(program)).toBe(`refused: ${english(SAID)}`);
  });

  test('rejects a run that fails with it as itself, so a caller can say it', async () => {
    const refusal = new Refusal(SAID);
    await expect(Effect.runPromise(Effect.fail(refusal))).rejects.toBe(refusal);
  });
});
