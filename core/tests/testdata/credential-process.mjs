/**
 * @fileoverview A credential_process program, as ~/.aws/config names one: it
 * prints the AWS CLI's version 1 answer alone.
 *
 * Usage: node credential-process.mjs <runs file> <expiration | none> [answer]
 *
 * Every run appends a line to the runs file, so a test can count how often uno
 * ran it. `answer` is how it answers: keys (the default), v2 for a version
 * newer than this build reads, junk for a plain text prompt in place of JSON,
 * and fail for a program that exits 1 with a reason on stderr.
 */

import { appendFileSync } from 'node:fs';

/**
 * keysAnswer is what a credential process prints when it has keys: the
 * version, the keys, and the expiration when there is one.
 * @param answer keys for the version this build reads, or v2 for one newer
 * @param expiration when the keys expire, or none
 * @return the JSON text
 */
function keysAnswer(answer, expiration) {
  return JSON.stringify({
    Version: answer === 'v2' ? 2 : 1,
    AccessKeyId: 'AKIDPROCESS',
    SecretAccessKey: 'process/secret',
    SessionToken: 'process-token',
    ...(expiration === 'none' ? {} : { Expiration: expiration }),
  });
}

/**
 * main records the run and answers as asked.
 * @param args the runs file, the expiration, and how to answer
 * @return the exit code
 */
function main(args) {
  const [runs, expiration, answer = 'keys'] = args;
  appendFileSync(runs, 'ran\n');

  if (answer === 'fail') {
    process.stderr.write('vault is sealed\nsecond line nobody needs\n');
    return 1;
  }
  if (answer === 'junk') {
    process.stdout.write('Enter your PIN:');
    return 0;
  }
  process.stdout.write(keysAnswer(answer, expiration));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
