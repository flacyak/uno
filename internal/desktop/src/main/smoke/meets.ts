// Checks that a workspace somebody sent waits for its bucket, and stops
// waiting once the bucket is connected, even when the object it names is
// gone: the tab then says what reading it said and offers Reload, and no
// longer asks for a connection.
//
// Opening the workspace closes the one the checks before them built.

import type { Check } from "./check.ts";

/** The colleague's workspace smoke.js wrote: one source, s3://open-data/2025/gone.csv. */
const SENT = process.env["UNO_SMOKE_SENT"] ?? "";

const LINE = `
  // The workspace's one line, unconnected or missing.
  const line = () => document.querySelector("#panel .panel-row.unconnected, #panel .panel-row.missing");
  `;

export const MEETS: Check[] = [
  {
    name: "a workspace somebody sent waits for its bucket to be connected",
    send: ["menu:open-path", SENT],
    script: `
      const want = "gone.uno reads s3://open-data/…, which no connection covers · connect open-data to read it";
      if (!(await arrives(() => text("#status-file") === want))) {
        return "the status bar says " + JSON.stringify(text("#status-file")) + " · " + JSON.stringify(text("#status-msg"));
      }
      return "";
    `,
  },
  {
    name: "connecting a bucket whose object has gone says why, and stops asking to connect it",
    shot: "meets-gone",
    script: `
      ${LINE}
      await openPanel();
      if (!(await arrives(() => line()?.classList.contains("unconnected") === true))) return "no line says it is not connected";
      line().click();
      const connect = () => footButton("Connect open-data");
      if (!(await until(() => connect() !== undefined))) return "the line offers " + JSON.stringify(foot());
      connect().click();
      if (connectForm().hidden) return "the form did not open";
      signInAs("public");
      saveConnection();

      // The bucket lists, so the connection is kept and the object is read at
      // once, and found missing.
      if (!(await arrives(() => line()?.classList.contains("missing") === true))) {
        return "the line still says " + JSON.stringify(line()?.textContent) + " · the status bar says " + JSON.stringify(text("#status-msg"));
      }
      if (line().children[1].textContent !== "missing") return "the line says " + JSON.stringify(line().textContent);
      // The reason is in the file's line, and the message line is empty.
      const why = "s3://open-data/2025/gone.csv: no such object in that bucket · point it at a file to see its rows";
      if (text("#status-file") !== why || text("#status-msg") !== "") {
        return "the status bar says " + JSON.stringify(text("#status-file")) + " · " + JSON.stringify(text("#status-msg"));
      }
      line().click();
      if (!(await until(() => foot().includes("Reload")))) return "the line offers " + JSON.stringify(foot());
      return foot().some((b) => b.startsWith("Connect")) ? "the line still offers " + JSON.stringify(foot()) : "";
    `,
  },
];
