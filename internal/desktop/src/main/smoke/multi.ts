// Checks that several objects are one tab: three picked in a folder of the
// stand-in bucket and added as one, read end to end as one table, and a
// fourth that lands in the folder afterwards offered on the tab's line and
// appended to it.
//
// They run last, over the workspace refresh.ts leaves open, and reach the
// folder through the connection to the whole bucket connections.ts saved.
// The objects are not in the bucket until a check asks smoke.js to put them
// there, so nothing before these lists a folder it did not expect.

import type { Check } from "./check.ts";
import { ROWS } from "./fixture.ts";
import { REMOTE } from "./sources.ts";

/** How many objects are added as one, before the folder gains another. */
const PARTS = 3;

/** The folder the objects are in, as the bucket keys it and as the panel says it. */
const FOLDER = "shop/2025/";

/** What each object is called: the fixture cut into parts, and one more. */
const NAMES = Array.from({ length: PARTS + 1 }, (_, i) => `sales-q3-part-${i + 1}.csv`);

/** The three added as one, and the one that lands after them, by their keys. */
const KEYS = NAMES.map((name) => FOLDER + name);
const FIRST = KEYS.slice(0, PARTS);
const LATER = KEYS[PARTS]!;

/** What the three are called as one tab: what their names share. */
const TAB = "sales-q3-part.csv";

/**
 * How many rows the three hold between them, which is the whole fixture, and
 * how many the fourth adds: it is the first part again, a third of it.
 */
const ROWS_AS_ONE = ROWS;
const ROWS_APPENDED = ROWS + ROWS / PARTS;

/** What the panel's lines say, and a key pressed where the panel reads them. */
const LINES = `
  const lines = () => {
    let at = -1;
    return [...document.querySelectorAll("#panel .panel-row")].map((r) => ({
      el: r, section: r.classList.contains("head") ? ++at : at,
      cls: r.className, name: r.children[0].textContent, meta: r.children[1].textContent,
    }));
  };
  const WORKSPACE = 0, CONNECTIONS = 1, BROWSER = 2;
  const named = (section) => lines().filter((l) => l.section === section && !/\\b(head|note)\\b/.test(l.cls));
  const names = (section) => JSON.stringify(named(section).map((l) => l.name));
  const line = (section, name) => named(section).find((l) => l.name === name);
  const crumb = () => lines().find((l) => l.section === BROWSER && l.cls.includes("head")).meta;
  const key = async (k) => {
    document.querySelector("#panel .panel-list")
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    await frame();
  };
  const foot = () => document.querySelector("#panel .panel-foot");
  const buttons = () => [...foot().querySelectorAll("button")];
  const labels = () => JSON.stringify(buttons().map((b) => b.textContent));
  const box = (el) => el.getBoundingClientRect();
`;

export const MULTI: Check[] = [
  {
    // The task's own sentence, first half: three stand-in objects, picked in
    // the folder they are in.
    name: "three objects picked in a folder are offered as one, with how they are read",
    ask: `put ${FIRST.join(" ")}`,
    shot: "multi-picked",
    script: `
      ${REMOTE}
      ${LINES}
      if (document.querySelector("#panel").hidden) await press("B", { ctrlKey: true, shiftKey: true });
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

      // Entering the folder left the keys on its first line.
      await key(" ");
      for (let i = 1; i < ${PARTS}; i++) {
        await key("ArrowDown");
        await key(" ");
      }
      if (!(await until(() => labels() === '["Add ${PARTS}","Add as one"]'))) return "the buttons are " + labels();

      const choices = foot().querySelector(".choices");
      if (choices === null) return "nothing says how the files are read as one";
      const said = [...choices.children].map((c) => c.textContent);
      if (JSON.stringify(said) !== '["as one","header row","_file column"]') return "the choices say " + JSON.stringify(said);
      const ticked = [...choices.querySelectorAll("input")].map((i) => i.checked);
      if (JSON.stringify(ticked) !== "[true,false]") return "the choices are ticked " + JSON.stringify(ticked);

      // Only a window lays anything out: the choices have a line to
      // themselves above the buttons, inside the panel, and none is cut short.
      const panel = box(document.querySelector("#panel"));
      const at = box(choices);
      if (at.left < panel.left || at.right > panel.right) return "the choices run from " + at.left + " to " + at.right + ", outside the panel";
      if (choices.scrollWidth > choices.clientWidth) return "the choices are cut short";
      const low = Math.min(...buttons().map((b) => box(b).top));
      return at.bottom <= low ? "" : "the choices end at " + at.bottom + ", under the buttons at " + low;
    `,
  },
  {
    name: "Add as one adds the three as one tab, read end to end",
    shot: "multi-added",
    script: `
      ${REMOTE}
      ${LINES}
      const tabs = document.querySelectorAll(".tab").length;
      // Asked for here, where the source is made, which is the one place it can be.
      const file = [...foot().querySelectorAll(".choices input")].at(-1);
      file.click();
      if (!(await until(() => [...foot().querySelectorAll(".choices input")].at(-1)?.checked === true))) {
        return "the _file column is not ticked once clicked";
      }
      buttons().find((b) => b.textContent === "Add as one").click();
      const active = () => document.querySelector(".tab.active")?.textContent ?? "";
      if (!(await arrives(() => active().startsWith(${JSON.stringify(TAB)})))) {
        return "the tab showing is " + JSON.stringify(active()) + " · " + JSON.stringify(text("#status-msg"));
      }
      const now = document.querySelectorAll(".tab").length;
      if (now !== tabs + 1) return "the sidebar went from " + tabs + " tabs to " + now;
      if (text("#status-msg") !== ${JSON.stringify(`added ${TAB}`)}) return "the status bar says " + JSON.stringify(text("#status-msg"));

      // Every row of all three, and no part's header among them: the whole
      // fixture, which is what they were cut from.
      const rows = ${JSON.stringify(ROWS_AS_ONE.toLocaleString("en-US"))} + " rows";
      if (!(await arrives(() => text("#status-file").startsWith(rows)))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      const head = [...document.querySelectorAll("thead th .colhead")].map((h) => h.firstChild.textContent);
      if (JSON.stringify(head) !== '["date","region","rep","channel","units","revenue","_file"]') return "the header is " + JSON.stringify(head);
      // The first row drawn is the first object's, and says so.
      const first = () => document.querySelector("tbody tr:not(.pending)")?.lastElementChild?.textContent;
      if (!(await arrives(() => first() === ${JSON.stringify(NAMES[0])}))) return "the first row's _file says " + JSON.stringify(first());
      const meta = () => line(WORKSPACE, ${JSON.stringify(TAB)})?.meta;
      return (await arrives(() => meta() === "${PARTS} files")) ? "" : "its line says " + JSON.stringify(meta());
    `,
  },
  {
    // The folder is not read again for the tab's parts. What it has gained
    // after the last of them is offered, on the next focus.
    name: "a fourth object landing in the folder is offered on the tab's line",
    ask: `put ${LATER}`,
    shot: "multi-grown",
    script: `
      ${REMOTE}
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

      // The offer is a sentence with a line of the foot to itself, as wide
      // as the foot's own padding lets it be, and Remove sits under it.
      const [wide, remove] = buttons();
      const inside = box(foot());
      const at = box(wide);
      const pad = parseFloat(getComputedStyle(foot()).paddingLeft);
      if (Math.abs(at.left - (inside.left + pad)) > 1 || Math.abs(at.right - (inside.right - pad)) > 1) {
        return "the offer runs from " + at.left + " to " + at.right + " in a foot from " + inside.left + " to " + inside.right;
      }
      if (at.height > box(remove).height + 1) return "the offer is " + at.height + "px tall, and Remove " + box(remove).height;
      return at.bottom <= box(remove).top ? "" : "the offer ends at " + at.bottom + ", under Remove at " + box(remove).top;
    `,
  },
  {
    // The task's own sentence, second half.
    name: "taking the offer appends the fourth, and the rows extend",
    shot: "multi-appended",
    script: `
      ${REMOTE}
      ${LINES}
      const tabs = document.querySelectorAll(".tab").length;
      buttons()[0].click();
      const said = ${JSON.stringify(`appended ${NAMES[PARTS]} to ${TAB}`)};
      if (!(await arrives(() => text("#status-msg") === said))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      const rows = ${JSON.stringify(ROWS_APPENDED.toLocaleString("en-US"))} + " rows";
      if (!(await arrives(() => text("#status-file").startsWith(rows)))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      if (document.querySelectorAll(".tab").length !== tabs) return "the sidebar has " + document.querySelectorAll(".tab").length + " tabs, not " + tabs;

      // Nothing is left to offer: the line says how many it reads now.
      const meta = () => line(WORKSPACE, ${JSON.stringify(TAB)})?.meta;
      if (!(await arrives(() => meta() === "${PARTS + 1} files"))) return "its line says " + JSON.stringify(meta());
      if (labels() !== '["Remove"]') return "its line offers " + labels();

      // The last row is the fourth object's last, drawn and not waited for.
      const sc = document.querySelector(".grid-scroll");
      sc.scrollTop = sc.scrollHeight;
      const last = () => [...document.querySelectorAll("tbody tr")].at(-1);
      const drawn = () => last()?.children[0].textContent === ${JSON.stringify(String(ROWS_APPENDED))} && !last().classList.contains("pending");
      if (!(await arrives(drawn))) return "the last row drawn is " + JSON.stringify(last()?.children[0].textContent);
      // It came from the object that was appended, and its _file cell names it.
      const from = last().lastElementChild.textContent;
      return from === ${JSON.stringify(NAMES[PARTS])} ? "" : "the last row's _file says " + JSON.stringify(from);
    `,
  },
];
