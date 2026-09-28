// A credential_process program, as ~/.aws/config names one: it prints the AWS
// CLI's version 1 answer and nothing else.
//
// Usage: node credential-process.mjs <runs file> <expiration | none> [answer]
//
// Every run appends a line to the runs file, so a test can count how often uno
// ran it. `answer` is how it answers: keys (the default), v2 for a version this
// build does not read, junk for something that is not JSON, and fail for a
// program that exits 1 with a reason on stderr.

import { appendFileSync } from "node:fs";

const [runs, expiration, answer = "keys"] = process.argv.slice(2);
appendFileSync(runs, "ran\n");

if (answer === "fail") {
  process.stderr.write("vault is sealed\nsecond line nobody needs\n");
  process.exit(1);
}
if (answer === "junk") {
  process.stdout.write("Enter your PIN:");
  process.exit(0);
}
process.stdout.write(
  JSON.stringify({
    Version: answer === "v2" ? 2 : 1,
    AccessKeyId: "AKIDPROCESS",
    SecretAccessKey: "process/secret",
    SessionToken: "process-token",
    ...(expiration === "none" ? {} : { Expiration: expiration }),
  }),
);
