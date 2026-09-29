// What the desktop engine does, end to end, for run.ts to watch: every way out
// the core has, taken the way a person's session takes it.
//
// A file on disk opened, listed and peeked at. An object in a bucket opened,
// listed and statted. A bucket read through a profile whose credential_process
// runs a program, and another through a role STS hands out. A connection
// tried and saved. Dropped bytes read. A workspace saved and opened again.
//
// Each is here so the guard has seen it happen in the one module allowed it,
// which is what makes "nothing else did" worth saying.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";

import { Engine, messagePort, serve } from "../../../src/engine/index.ts";
import type { MessagePortLike, Reply, Request } from "../../../src/engine/index.ts";
import type { Connection } from "../../../src/library/index.ts";
import { sources } from "../../../src/plugin/index.ts";
import { blobProvider, connectionsIn, saveConnection } from "../../../src/store/index.ts";
import {
  awsProfiles,
  connectionAuth,
  connectionSigning,
  diskProvider,
  nodeStore,
} from "../../../src/store/node.ts";
import { s3Provider, tryConnection } from "../../../src/store/s3.ts";
import { bytes } from "../../testdata/sales-q3.ts";
import { HOME_REGION } from "../regions.ts";
import { KEYS, bucket } from "../standin.ts";
import { sts } from "../stsstandin.ts";

const PROCESS = fileURLToPath(new URL("../../testdata/credential-process.mjs", import.meta.url));

/** What the credential_process fixture prints, and the role STS hands out. */
const PRINTED = { accessKeyId: "AKIDPROCESS", secretAccessKey: "process/secret" };
const SESSION = {
  accessKeyId: "ASIDREADER",
  secretAccessKey: "reader/secret",
  sessionToken: "reader-token",
};
const READER = "arn:aws:iam::210987654321:role/uno-read";

function connection(id: string, bucket: string, profile: string): Connection {
  return {
    format: 1,
    id,
    name: id,
    provider: "s3",
    bucket,
    prefix: "",
    auth: { mode: "profile", profile },
    created: undefined,
    modified: undefined,
  };
}

export default async function everything(): Promise<void> {
  const role = await sts(
    [KEYS],
    new Map([[READER, { callers: [KEYS.accessKeyId], session: SESSION }]]),
  );
  const b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-vault": {
      objects: new Map([["q3/ledger.csv", bytes]]),
      keys: { ...PRINTED, sessionToken: "process-token", region: HOME_REGION },
    },
    "acme-finance-lake": {
      objects: new Map([["exports/ledger.csv", bytes]]),
      keys: { ...SESSION, region: HOME_REGION },
    },
  });

  // A machine of its own: three profiles, one of each kind this touches.
  const home = await mkdtemp(join(tmpdir(), "uno-reach-"));
  const runs = join(home, "runs");
  await writeFile(runs, "");
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  const program = [process.execPath, PROCESS, runs, later].map((w) => `"${w}"`).join(" ");
  await writeFile(
    join(home, "config"),
    [
      `[profile finance]\nregion = ${HOME_REGION}\n`,
      `[profile vault]\ncredential_process = ${program}\nregion = ${HOME_REGION}\n`,
      `[profile reader]\nrole_arn = ${READER}\nsource_profile = finance\nregion = ${HOME_REGION}\n`,
    ].join("\n"),
  );
  await writeFile(
    join(home, "credentials"),
    `[finance]\naws_access_key_id = ${KEYS.accessKeyId}\naws_secret_access_key = ${KEYS.secretAccessKey}\n`,
  );
  const env = {
    HOME: home,
    AWS_CONFIG_FILE: join(home, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
    AWS_ENDPOINT_URL_STS: role.endpoint,
    AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
    AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
    AWS_REGION: HOME_REGION,
    AWS_PROFILE: undefined,
    AWS_SESSION_TOKEN: undefined,
  };

  const store = nodeStore();
  const folder = join(home, "connections");
  await mkdir(folder);
  await saveConnection(store, folder, connection("vault", "acme-vault", "vault"));
  await saveConnection(store, folder, connection("lake", "acme-finance-lake", "reader"));
  const kept = connectionsIn(store, folder);
  const auth = connectionAuth(env);

  /** An engine wired the way src/engine/index.ts on the desktop wires one. */
  function engine(): Engine {
    const { port1, port2 } = new MessageChannel();
    serve(
      messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
      sources([
        diskProvider(),
        blobProvider(),
        s3Provider({
          credentials: connectionSigning(() => kept.all, env, auth),
          endpoint: b.endpoint,
        }),
      ]),
      undefined,
      {
        connections: kept,
        profiles: () => awsProfiles(env),
        test: (c) => tryConnection(c, { sign: (x) => auth.of(x), endpoint: b.endpoint }),
      },
    );
    return new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
  }

  const local = join(home, "sales-q3.csv");
  await writeFile(local, bytes);
  const uno = join(home, "q3.uno");

  const first = engine();
  try {
    await first.connections();
    await first.profiles();
    await first.list(home);
    await first.stat(local);
    await first.peek({ name: "sales-q3.csv", path: local });
    await first.open({ name: "sales-q3.csv", path: local });
    await first.list("s3://acme-exports/2025/");
    await first.stat("s3://acme-exports/2025/sales-q3.csv");
    await first.open({ name: "ads.csv", path: "s3://acme-exports/2025/sales-q3.csv" });
    await first.open({ name: "vault.csv", path: "s3://acme-vault/q3/ledger.csv" });
    await first.open({ name: "lake.csv", path: "s3://acme-finance-lake/exports/ledger.csv" });
    await first.open({ name: "dropped.csv", blob: new Blob([bytes]) });
    await first.tryConnection(connection("try", "acme-exports", "finance"));
    await writeFile(uno, await first.save({ source: "sales-q3", cells: [], at: uno }, 1 << 20));
  } finally {
    first.close();
  }

  const second = engine();
  try {
    await second.open({ name: "q3.uno", path: uno });
  } finally {
    second.close();
  }
  await b.close();
  await role.close();
}
