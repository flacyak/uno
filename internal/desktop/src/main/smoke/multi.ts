// Checks that several objects are one tab: three picked in a folder of the
// stand-in bucket and added as one, read end to end as one table, and a
// fourth that lands in the folder afterwards, offered on the tab's line and
// appended to it.
//
// They run over the workspace refresh.ts leaves open, and reach the folder
// through the whole-bucket connection connections.ts saved. The objects are
// put in the bucket when a check asks smoke.js to.

import type { Check } from "./check.ts";
import { ROWS, counted } from "./fixture.ts";

/** How many objects are added as one, before the folder gains another. */
const PARTS = 3;

/** The folder the objects are in, as the bucket keys it and as the panel says it. */
const FOLDER = "shop/2025/";

/** The objects' names: the fixture cut into parts, and one more. */
const NAMES = Array.from({ length: PARTS + 1 }, (_, i) => `sales-q3-part-${i + 1}.csv`);

/** The keys: the three added as one, and the one that lands after them. */
const KEYS = NAMES.map((name) => FOLDER + name);
const FIRST = KEYS.slice(0, PARTS);
const LATER = KEYS[PARTS]!;

/** The tab's name for the three: the part their names share. */
const TAB = "sales-q3-part.csv";

/**
 * How many rows the three hold together (the whole fixture), and how many
 * once the fourth is appended (the first part again, a third more).
 */
const ROWS_AS_ONE = ROWS;
const ROWS_APPENDED = ROWS + ROWS / PARTS;

/** Helpers over the panel's lines, beside the PRELUDE's. */
const LINES = `
  const names = (section) => JSON.stringify(named(section).map((l) => l.name));
  const line = (section, name) => named(section).find((l) => l.name === name);
  const crumb = () => head(BROWSER).meta;
  const footer = () => document.querySelector("#panel .panel-foot");
  const labels = () => JSON.stringify(foot());
  const box = (el) => el.getBoundingClientRect();
`;

export const MULTI: Check[] = [
  {
    name: "three objects picked in a folder are offered as one, with how they are read",
    ask: `put ${FIRST.join(" ")}`,
    shot: "multi-picked",
    script: `
      ${LINES}
      await openPanel();
      if (!(await arrives(() => line(CONNECTIONS, "acme-exports") !== undefined))) {
        return "the connections are " + names(CONNECTIONS);
      }
      line(CONNECTIONS, "acme-exports").el.click();
      if (!(await arrives(() => names(BROWSER) === '["2025/","shop/"]'))) return "the bucket lists " + names(BROWSER);
      line(BROWSER, "shop/").el.click();
      if (!(await arrives(() => names(BROWSER) === '["2025/"]' && crumb() === "acme-exports / shop"))) {
        return "shop/ lists " + names(BROWSER) + " under " + JSON.stringify(crumb());
      }
      line(BROWSER, "2025/").el.click();
      const want = ${JSON.stringify(JSON.stringify(NAMES.slice(0, PARTS)))};
      if (!(await arrives(() => names(BROWSER) === want))) return "the folder lists " + names(BROWSER);

      // Entering the folder left the selection on its first line.
      await key(" ");
      for (let i = 1; i < ${PARTS}; i++) {
        await key("ArrowDown");
        await key(" ");
      }
      if (!(await until(() => labels() === '["Add ${PARTS}","Add as one"]'))) return "the buttons are " + labels();

      const choices = footer().querySelector(".choices");
      if (choices === null) return "nothing says how the files are read as one";
      const said = [...choices.children].map((c) => c.textContent);
      if (JSON.stringify(said) !== '["as one","header row","_file column"]') return "the choices say " + JSON.stringify(said);
      const ticked = [...choices.querySelectorAll("input")].map((i) => i.checked);
      if (JSON.stringify(ticked) !== "[true,false]") return "the choices are ticked " + JSON.stringify(ticked);

      // Layout: the choices have a line of their own above the buttons,
      // inside the panel, and none is cut short.
      const panel = box(document.querySelector("#panel"));
      const at = box(choices);
      if (at.left < panel.left || at.right > panel.right) return "the choices run from " + at.left + " to " + at.right + ", outside the panel";
      if (choices.scrollWidth > choices.clientWidth) return "the choices are cut short";
      const low = Math.min(...footButtons().map((b) => box(b).top));
      return at.bottom <= low ? "" : "the choices end at " + at.bottom + ", under the buttons at " + low;
    `,
  },
  {
    name: "Add as one adds the three as one tab, read end to end",
    shot: "multi-added",
    script: `
      ${LINES}
      const tabs = document.querySelectorAll(".tab").length;
      // The _file column is chosen here, where the source is made.
      const file = [...footer().querySelectorAll(".choices input")].at(-1);
      file.click();
      if (!(await until(() => [...footer().querySelectorAll(".choices input")].at(-1)?.checked === true))) {
        return "the _file column is not ticked once clicked";
      }
      footButtons().find((b) => b.textContent === "Add as one").click();
      const active = () => document.querySelector(".tab.active")?.textContent ?? "";
      if (!(await arrives(() => active().startsWith(${JSON.stringify(TAB)})))) {
        return "the tab showing is " + JSON.stringify(active()) + " · " + JSON.stringify(text("#status-msg"));
      }
      const now = document.querySelectorAll(".tab").length;
      if (now !== tabs + 1) return "the sidebar went from " + tabs + " tabs to " + now;
      if (text("#status-msg") !== ${JSON.stringify(`added ${TAB}`)}) return "the status bar says " + JSON.stringify(text("#status-msg"));

      // Every row of all three under one header: the whole fixture.
      const rows = ${JSON.stringify(counted(ROWS_AS_ONE))} + " rows";
      if (!(await arrives(() => text("#status-file").startsWith(rows)))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      const head = [...document.querySelectorAll("thead th .colhead")].map((h) => h.firstChild.textContent);
      if (JSON.stringify(head) !== '["date","region","rep","channel","units","revenue","_file"]') return "the header is " + JSON.stringify(head);
      // The first row drawn is the first object's, and its _file cell says so.
      const first = () => document.querySelector("tbody tr:not(.pending)")?.lastElementChild?.textContent;
      if (!(await arrives(() => first() === ${JSON.stringify(NAMES[0])}))) return "the first row's _file says " + JSON.stringify(first());
      const meta = () => line(WORKSPACE, ${JSON.stringify(TAB)})?.meta;
      return (await arrives(() => meta() === "${PARTS} files")) ? "" : "its line says " + JSON.stringify(meta());
    `,
  },
  {
    // On the next focus the folder is listed again, and what it gained after
    // the last part is offered.
    name: "a fourth object landing in the folder is offered on the tab's line",
    ask: `put ${LATER}`,
    shot: "multi-grown",
    script: `
      ${LINES}
      const meta = () => line(WORKSPACE, ${JSON.stringify(TAB)})?.meta;
      if (meta() !== "${PARTS} files") return "before the focus its line says " + JSON.stringify(meta());
      window.dispatchEvent(new Event("focus"));
      if (!(await arrives(() => meta() === "1 new file"))) return "after the focus its line says " + JSON.stringify(meta());

      // The browser is still in the folder, and lists what it holds now.
      const all = ${JSON.stringify(JSON.stringify(NAMES))};
      if (!(await arrives(() => names(BROWSER) === all))) return "the folder lists " + names(BROWSER);

      line(WORKSPACE, ${JSON.stringify(TAB)}).el.click();
      const offer = ${JSON.stringify(`1 new file in ${FOLDER} · append`)};
      if (!(await until(() => labels() === JSON.stringify([offer, "Remove"])))) return "its line offers " + labels();

      // The offer has a line of the foot to itself, as wide as the foot's
      // padding allows, with Remove under it.
      const [wide, remove] = footButtons();
      const inside = box(footer());
      const at = box(wide);
      const pad = parseFloat(getComputedStyle(footer()).paddingLeft);
      if (Math.abs(at.left - (inside.left + pad)) > 1 || Math.abs(at.right - (inside.right - pad)) > 1) {
        return "the offer runs from " + at.left + " to " + at.right + " in a foot from " + inside.left + " to " + inside.right;
      }
      if (at.height > box(remove).height + 1) return "the offer is " + at.height + "px tall, and Remove " + box(remove).height;
      return at.bottom <= box(remove).top ? "" : "the offer ends at " + at.bottom + ", under Remove at " + box(remove).top;
    `,
  },
  {
    name: "taking the offer appends the fourth, and the rows extend",
    shot: "multi-appended",
    script: `
      ${LINES}
      const tabs = document.querySelectorAll(".tab").length;
      footButtons()[0].click();
      const said = ${JSON.stringify(`appended ${NAMES[PARTS]} to ${TAB}`)};
      if (!(await arrives(() => text("#status-msg") === said))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      const rows = ${JSON.stringify(counted(ROWS_APPENDED))} + " rows";
      if (!(await arrives(() => text("#status-file").startsWith(rows)))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      if (document.querySelectorAll(".tab").length !== tabs) return "the sidebar has " + document.querySelectorAll(".tab").length + " tabs, not " + tabs;

      // Remove is all the line offers, and it says how many files it reads now.
      const meta = () => line(WORKSPACE, ${JSON.stringify(TAB)})?.meta;
      if (!(await arrives(() => meta() === "${PARTS + 1} files"))) return "its line says " + JSON.stringify(meta());
      if (labels() !== '["Remove"]') return "its line offers " + labels();

      // The last row is the fourth object's last, and it is drawn.
      const sc = document.querySelector(".grid-scroll");
      sc.scrollTop = sc.scrollHeight;
      const last = () => [...document.querySelectorAll("tbody tr")].at(-1);
      const drawn = () => last()?.children[0].textContent === ${JSON.stringify(counted(ROWS_APPENDED))} && !last().classList.contains("pending");
      if (!(await arrives(drawn))) return "the last row drawn is " + JSON.stringify(last()?.children[0].textContent);
      // Its _file cell names the object that was appended.
      const from = last().lastElementChild.textContent;
      return from === ${JSON.stringify(NAMES[PARTS])} ? "" : "the last row's _file says " + JSON.stringify(from);
    `,
  },
];
