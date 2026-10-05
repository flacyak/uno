// Checks that a workspace holds more than one source: a second export added
// beside the first, a tab for each, moving between them, and taking one out.
// Then the same again for a source that is not on this machine at all: an
// object in a bucket, pasted into the sources panel the + menu opens, drawn,
// saved as an `s3://` pointer and read back from one.
//
// They run last, over the fixture the checks before them left edited.

import { join } from "node:path";

import type { Check } from "./check.ts";

/**
 * The second export: the Google Ads sample the CPA plan measures. smoke.js
 * names it, since only it knows where the fixtures are.
 */
const ADS = process.env["UNO_SMOKE_SOURCE"] ?? "";

/**
 * The same export again, as an object: the address a person would paste into
 * the sources panel's filter. smoke.js stands an S3 up in front of the fixture and names it
 * here, so nothing in the app knows the bucket is a stand-in.
 */
const OBJECT = process.env["UNO_SMOKE_OBJECT"] ?? "";

/** The only folder this run may write in. smoke.js reads the .uno back out of it. */
const SCRATCH = process.env["UNO_SMOKE"] ?? "";

/**
 * Where the save lands: the scratch folder the save dialog's stand-in answers
 * from, under the name the workspace suggests -- its first source's, which is
 * the fixture the run opened with.
 *
 * The reopen has to name it before the run starts, since a check's message to
 * the window is fixed when this list is built and cannot read what an earlier
 * check saw. The save check says so when the two disagree.
 */
const SAVED = join(SCRATCH, "sales-q3.uno");

/**
 * A wait for something coming over the network.
 *
 * The PRELUDE's `until` is counted in frames, which is the right size for the
 * app catching up with itself and too small for a signed request, a bucket, and
 * 2,600 rows on the way back.
 */
export const REMOTE = `
  const arrives = async (ok) => {
    for (let i = 0; i < 4; i++) if (await until(ok)) return true;
    return false;
  };
`;

export const SOURCES: Check[] = [
  {
    name: "one source has no × to remove it with",
    script: `
      window.smokeCell = text("#status-cell");
      const tabs = document.querySelectorAll(".tab");
      if (tabs.length !== 1) return tabs.length + " tabs before any source was added";
      return document.querySelector(".tab .close") === null ? "" : "the only source can be removed";
    `,
  },
  {
    name: "a second export is added as a source beside the first",
    send: ["menu:add-paths", [ADS]],
    script: `
      if (!(await until(() => document.querySelectorAll(".tab").length === 2))) {
        return "the sidebar has " + document.querySelectorAll(".tab").length + " tabs · " + text("#status-msg");
      }
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("google-ads-sales.csv")) return "the tab showing is " + JSON.stringify(active);
      if (!(await until(() => text("#status-file").startsWith("2,600 rows")))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      const first = document.querySelector("thead th .colhead").firstChild.textContent;
      return first === "Ad_ID" ? "" : "the first header is " + JSON.stringify(first);
    `,
  },
  {
    name: "the new source is unsaved, and the first keeps its own dot",
    script: `
      const dots = [...document.querySelectorAll(".tab")].map((t) => t.querySelector(".dirty") !== null);
      return JSON.stringify(dots) === "[true,true]" ? "" : "dirty dots are " + JSON.stringify(dots);
    `,
  },
  {
    name: "Ctrl+PageUp goes back to the first source, where it was left",
    script: `
      await press("PageUp", { ctrlKey: true });
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("sales-q3.csv")) return "the tab showing is " + JSON.stringify(active);
      if (!text("#status-file").startsWith(counted(ROWS) + " rows")) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      return text("#status-cell") === window.smokeCell
        ? ""
        : "the selection came back at " + text("#status-cell") + ", not " + window.smokeCell;
    `,
  },
  {
    name: "a click on a tab shows its source",
    script: `
      document.querySelector('.tab[data-source="google-ads-sales"]').click();
      await frame();
      const first = document.querySelector("thead th .colhead").firstChild.textContent;
      return first === "Ad_ID" ? "" : "the first header is " + JSON.stringify(first);
    `,
  },
  {
    name: "× takes out a source with no edits at once",
    script: `
      document.querySelector('.tab[data-source="google-ads-sales"] .close').click();
      if (!(await until(() => document.querySelectorAll(".tab").length === 1))) {
        return "the sidebar still has " + document.querySelectorAll(".tab").length + " tabs";
      }
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("sales-q3.csv")) return "the tab showing is " + JSON.stringify(active);
      return text("#status-msg") === "removed google-ads-sales.csv"
        ? ""
        : "the status bar says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "the + offers a file or the sources panel",
    script: `
      document.querySelector(".tab-add").click();
      await frame();
      const menu = document.querySelector(".pop-menu");
      if (menu === null) return "the + opened no menu";
      // The label is the item's first child: what follows it is the keys it
      // answers to.
      const items = [...menu.querySelectorAll(".pop-item")].map((i) => i.firstChild.textContent);
      return JSON.stringify(items) === JSON.stringify(["File…", "Browse sources…"])
        ? ""
        : "the menu offers " + JSON.stringify(items);
    `,
  },
  {
    name: "Browse sources… opens the panel with the keys in it",
    script: `
      const items = [...document.querySelectorAll(".pop-item")];
      const browse = items.find((i) => i.firstChild.textContent === "Browse sources…");
      if (browse === undefined) return "the menu has no Browse sources… to choose";
      browse.click();
      await frame();

      if (document.querySelector(".pop-menu") !== null) return "the menu stayed open";
      const panel = document.querySelector("#panel");
      if (panel.hidden) return "the panel is still closed";
      return document.activeElement === panel.querySelector(".panel-list")
        ? ""
        : "the keys are in " + (document.activeElement?.className ?? "nothing");
    `,
  },
  {
    name: "the object in the bucket is added from the panel's filter, and its rows are drawn",
    script: `
      ${REMOTE}
      const form = document.querySelector("#panel .panel-filter");
      if (form === null) return "the panel has no filter box";
      form.querySelector("input").value = ${JSON.stringify(OBJECT)};
      // Enter in the box is the form's submit, and the PRELUDE's press aims at
      // the grid, which the box stops keys short of.
      form.requestSubmit();

      // Everything the engine can refuse comes back as one line, and this is
      // the only place a run leaves it: a 403 is the signature or the region, a
      // 404 is the key, and neither is visible anywhere else afterwards.
      if (!(await arrives(() => document.querySelectorAll(".tab").length === 2))) {
        return "the sidebar has " + document.querySelectorAll(".tab").length +
          " tabs · " + JSON.stringify(text("#status-msg"));
      }
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("ads-q3.csv")) {
        return "the tab showing is " + JSON.stringify(active) + " · " + JSON.stringify(text("#status-msg"));
      }
      if (!(await arrives(() => text("#status-file").startsWith("2,600 rows")))) {
        return "the status bar says " + JSON.stringify(text("#status-file")) +
          " · " + JSON.stringify(text("#status-msg"));
      }
      const first = document.querySelector("thead th .colhead").firstChild.textContent;
      return first === "Ad_ID"
        ? ""
        : "the first header is " + JSON.stringify(first) + " · " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    // A stand-in that quietly served the fixture sitting next to it would pass
    // everything above. These values are only in the object.
    name: "the rows came out of the bucket, not from beside it",
    script: `
      ${REMOTE}
      document.querySelector(".grid-scroll").scrollTop = 0;
      await frame();
      if (!(await arrives(() => document.querySelector("tbody tr:not(.pending)") !== null))) {
        return "no row of the object was drawn · " + JSON.stringify(text("#status-msg"));
      }

      // Ad_ID,Campaign_Name,Clicks,Impressions,Cost,Leads,Conversions,
      // Conversion Rate,Sale_Amount,Ad_Date,... -- row 1, spelt as the file
      // spells it, costume and all.
      const AD_ID = 0, CAMPAIGN = 1, COST = 4, AD_DATE = 9;
      const cells = [...document.querySelectorAll("tbody tr")[0].children].map((c) => c.textContent);
      const got = [cells[GUTTER + AD_ID], cells[GUTTER + CAMPAIGN], cells[GUTTER + COST], cells[GUTTER + AD_DATE]];
      return JSON.stringify(got) === JSON.stringify(["A1000", "DataAnalyticsCourse", "$231.88", "2024-11-16"])
        ? ""
        : "row 1 is " + JSON.stringify(cells);
    `,
  },
  {
    name: "the workspace saves, object and all",
    send: ["menu:save"],
    script: `
      ${REMOTE}
      if (!(await arrives(() => text("#status-msg").startsWith("saved ")))) {
        return "saving says " + JSON.stringify(text("#status-msg"));
      }
      const path = text("#status-msg").slice("saved ".length);
      if (!path.startsWith(${JSON.stringify(SCRATCH)})) {
        return "the workspace saved to " + JSON.stringify(path) +
          ", outside this run's " + ${JSON.stringify(SCRATCH)};
      }
      // What is in the file is smoke.js's to say: the page cannot read a .uno
      // back off the disk, and has no business being able to.
      return path === ${JSON.stringify(SAVED)}
        ? ""
        : "saved to " + JSON.stringify(path) + ", but the reopen asks for " + ${JSON.stringify(SAVED)};
    `,
  },
  {
    // The .uno names a bucket this run has made no connection to, so the
    // object is not read: it opens waiting, and says which bucket it wants.
    name: "the saved workspace opens again, and the object waits for its bucket to be connected",
    send: ["menu:open-path", SAVED],
    shot: "meets-waiting",
    script: `
      ${REMOTE}
      // A load that works clears the line the save left. One that fails puts
      // its reason there and leaves the old workspace showing -- which holds
      // the same two tabs, and would otherwise look exactly like a reopen.
      if (!(await arrives(() => text("#status-msg") === ""))) {
        return "reopening " + ${JSON.stringify(SAVED)} + " says " + JSON.stringify(text("#status-msg"));
      }
      const tabs = [...document.querySelectorAll(".tab")].map((t) => t.textContent);
      if (tabs.length !== 2) return "the reopened workspace has " + JSON.stringify(tabs);
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("ads-q3.csv")) return "the tab showing is " + JSON.stringify(active);
      const want = "sales-q3.uno reads s3://acme-exports/…, which no connection covers · connect acme-exports to read it";
      if (!(await arrives(() => text("#status-file") === want))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      // No file, so no cell for the selection to be on.
      return text("#status-cell") === "" ? "" : "the selection is at " + JSON.stringify(text("#status-cell"));
    `,
  },
  {
    name: "Connect on its line connects the object's folder, filled in, and the object comes back",
    shot: "meets-connected",
    script: `
      ${REMOTE}
      await press("B", { ctrlKey: true, shiftKey: true });
      const line = () => [...document.querySelectorAll("#panel .panel-row.unconnected")][0];
      if (!(await arrives(() => line() !== undefined))) return "no line says it is not connected";
      if (line().children[1].textContent !== "not connected") return "the line says " + JSON.stringify(line().textContent);
      line().click();
      const button = () => [...document.querySelectorAll("#panel .panel-foot button")].find((b) => b.textContent === "Connect acme-exports");
      if (!(await until(() => button() !== undefined))) {
        return "the line offers " + JSON.stringify([...document.querySelectorAll("#panel .panel-foot button")].map((b) => b.textContent));
      }
      button().click();
      const form = document.querySelector("#panel .panel-connect");
      if (form.hidden) return "the form did not open";
      if (form.querySelector("input[name=bucket]").value !== "acme-exports") return "the bucket was not filled in";
      if (form.querySelector("input[name=prefix]").value !== "2025/") return "the folder was not filled in";
      const choose = form.querySelector("select");
      if (!(await arrives(() => [...choose.options].some((o) => o.value === "profile:finance")))) return "no finance profile to choose";
      choose.value = "profile:finance";
      choose.dispatchEvent(new Event("change", { bubbles: true }));
      [...form.querySelectorAll("button")].find((b) => b.textContent === "Save connection").click();

      if (!(await arrives(() => text("#status-msg") === "ads-q3.csv reads from acme-exports / 2025"))) {
        return "the status bar says " + JSON.stringify(text("#status-msg")) + " · the form says " + JSON.stringify(form.querySelector(".result").textContent);
      }
      if (!(await arrives(() => document.querySelector("thead th .colhead") !== null))) {
        return "no header came back · " + JSON.stringify(text("#status-file"));
      }
      const first = document.querySelector("thead th .colhead").firstChild.textContent;
      if (first !== "Ad_ID") return "the first header is " + JSON.stringify(first);
      // The panel checks after these open it themselves, and expect the keys
      // on the tabs, where a panel nobody has used yet has them. The keys stay
      // where they were left when a panel closes, so they are walked back up
      // first: saving the connection left them in the browser.
      const list = document.querySelector("#panel .panel-list");
      const key = (k) => list.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      for (let i = 0; i < 20; i++) key("ArrowUp");
      key("Escape");
      return (await until(() => document.querySelector("#panel").hidden)) ? "" : "Esc did not close the panel";
    `,
  },
];
