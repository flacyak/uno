// Checks of the sidebar: the workspaces this run opened, listed with the open
// one first and its sources under it, moving between them, a formula inserted
// from a right click, and the × that closes the window asking before it drops
// anything.
//
// They run over the workspace the checks before them saved, reopened and
// added to, with the colleague's workspace beside it in the list.

import type { Check } from "./check.ts";

/** Helpers: a right click on a line, the names in a list, and the context
 * menu's items. */
const RIGHT_CLICK = `
  const rightClick = (el) => {
    const at = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(at.left + at.width / 2),
      clientY: Math.round(at.top + at.height / 2),
    }));
  };
  const names = (selector) => [...document.querySelectorAll(selector)].map((w) => w.querySelector(".name").textContent);
  const offered = () => [...document.querySelectorAll(".pop-menu .pop-item")].map((i) => i.firstChild.textContent);
  const choose = (label) => [...document.querySelectorAll(".pop-menu .pop-item")].find((i) => i.firstChild.textContent === label).click();
`;

/** The column the formula checks put a formula into. */
const CHANNEL = 3;

export const SIDEBAR: Check[] = [
  {
    name: "the window has no bar over the page, and the sidebar lists the open workspace first",
    script: `
      ${RIGHT_CLICK}
      if (document.querySelector("#tabs, .win-tabs") !== null) return "the tab strip is still there";
      const top = document.querySelector(".win-frame").getBoundingClientRect().top;
      if (top !== 0) return "the page starts " + top + "px down";
      const open = names(".ws.open");
      if (JSON.stringify(open) !== JSON.stringify(["sales-q3"])) return "the open workspace is " + JSON.stringify(open);
      const first = document.querySelector("#workspaces").firstElementChild;
      if (!first.classList.contains("open")) return "the list begins with " + JSON.stringify(first.textContent);
      // Its sources come under it, and the other workspaces after them.
      const order = [...document.querySelectorAll("#workspaces > *")].map((el) => el.classList[0]);
      const tabs = document.querySelectorAll(".tab").length;
      const want = ["ws", ...Array(tabs).fill("tab"), "tab-add", "ws"];
      if (JSON.stringify(order) !== JSON.stringify(want)) return "the list is " + JSON.stringify(order);
      const others = names(".ws:not(.open)");
      return JSON.stringify(others) === JSON.stringify(["gone"]) ? "" : "the others are " + JSON.stringify(others);
    `,
  },
  {
    name: "Ctrl+B closes the sidebar and the grid takes its width, and the switch opens it again",
    script: `
      const sidebar = document.querySelector("#sidebar");
      const grid = document.querySelector("#content");
      const wide = sidebar.offsetWidth;
      if (wide === 0) return "the sidebar is closed to begin with";
      const was = grid.offsetWidth;
      await press("b", { ctrlKey: true });
      if (sidebar.offsetWidth !== 0) return "Ctrl+B left the sidebar " + sidebar.offsetWidth + "px wide";
      if (grid.offsetWidth !== was + wide) return "the grid is " + grid.offsetWidth + "px wide, not " + (was + wide);
      const toggle = document.querySelector("#sidebar-toggle");
      if (toggle.classList.contains("on")) return "the switch still says open";
      toggle.click();
      await frame();
      if (sidebar.offsetWidth !== wide) return "the switch left the sidebar " + sidebar.offsetWidth + "px wide";
      return toggle.classList.contains("on") ? "" : "the switch does not say open";
    `,
  },
  {
    // The workspace has unsaved sources, so the first click only warns.
    name: "another workspace picked over unsaved work says so, and opens on the second click",
    script: `
      ${RIGHT_CLICK}
      const gone = () => [...document.querySelectorAll(".ws:not(.open)")].find((w) => w.querySelector(".name").textContent === "gone");
      gone().click();
      await frame();
      const want = "unsaved edits · Ctrl+S first, or click again to drop them";
      if (text("#status-msg") !== want) return "the first click says " + JSON.stringify(text("#status-msg"));
      if (names(".ws.open")[0] !== "sales-q3") return "the first click opened " + JSON.stringify(names(".ws.open"));
      gone().click();
      if (!(await arrives(() => names(".ws.open")[0] === "gone"))) {
        return "the open workspace is " + JSON.stringify(names(".ws.open")) + " · " + JSON.stringify(text("#status-msg"));
      }
      const others = names(".ws:not(.open)");
      return JSON.stringify(others) === JSON.stringify(["sales-q3"]) ? "" : "the others are " + JSON.stringify(others);
    `,
  },
  {
    // The dialog is answered with the second export: see pick.ts.
    name: "the + at the foot of the sidebar opens a file as a new workspace, not saved yet",
    script: `
      ${RIGHT_CLICK}
      const plus = document.querySelector("#new");
      const foot = document.querySelector("#sidebar").getBoundingClientRect().bottom - plus.getBoundingClientRect().bottom;
      if (foot < 0 || foot > 12) return "the + is " + foot + "px from the foot of the sidebar";
      if (!plus.textContent.includes("+")) return "the + says " + JSON.stringify(plus.textContent);
      plus.click();
      if (!(await arrives(() => names(".ws.open")[0] === "google-ads-sales"))) {
        return "the open workspace is " + JSON.stringify(names(".ws.open")) + " · " + JSON.stringify(text("#status-msg"));
      }
      const meta = document.querySelector(".ws.open .meta").textContent;
      if (meta !== "not saved") return "the new workspace says " + JSON.stringify(meta);
      if (document.querySelectorAll(".tab").length !== 1) return "it has " + document.querySelectorAll(".tab").length + " sources";
      // The new workspace is unsaved, so the list holds what it did before.
      const others = names(".ws:not(.open)");
      return JSON.stringify(others) === JSON.stringify(["gone", "sales-q3"]) ? "" : "the others are " + JSON.stringify(others);
    `,
  },
  {
    // Thirteen columns, wider than the window: the grid scrolls along to
    // follow the selection.
    name: "the selection moved to a column off the side of a wide file brings it on screen",
    script: `
      if (!(await arrives(() => document.querySelector("tbody tr:not(.pending)") !== null))) return "no rows were drawn";
      const scroller = document.querySelector(".grid-scroll");
      if (scroller.scrollWidth <= scroller.clientWidth) return "the file fits the window, so this checks nothing";
      const last = document.querySelectorAll("thead th").length - 1 - GUTTER;
      for (let i = 0; i < last; i++) await press("ArrowRight");
      const cell = document.querySelector("td.sel").getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (cell.right > view.left + scroller.clientWidth + 1) return "the selected cell ends at " + cell.right + ", past " + (view.left + scroller.clientWidth);
      if (scroller.scrollLeft === 0) return "the grid did not scroll along";
      for (let i = 0; i < last; i++) await press("ArrowLeft");
      return scroller.scrollLeft === 0 ? "" : "back at the first column the grid is " + scroller.scrollLeft + "px along";
    `,
  },
  {
    name: "a workspace with nothing unsaved gives way at once, and the one opened is first again",
    script: `
      ${RIGHT_CLICK}
      [...document.querySelectorAll(".ws:not(.open)")].find((w) => w.querySelector(".name").textContent === "sales-q3").click();
      if (!(await arrives(() => names(".ws.open")[0] === "sales-q3"))) {
        return "the open workspace is " + JSON.stringify(names(".ws.open")) + " · " + JSON.stringify(text("#status-msg"));
      }
      if (document.querySelectorAll(".tab .dirty").length !== 0) return "a workspace just opened has a dirty dot";
      document.querySelector('.tab[data-source="sales-q3"]').click();
      return (await arrives(() => text("#status-file").startsWith(counted(ROWS) + " rows")))
        ? ""
        : "the status bar says " + JSON.stringify(text("#status-file"));
    `,
  },
  {
    name: "a right click on the open workspace offers a formula, a source and a save",
    script: `
      ${RIGHT_CLICK}
      rightClick(document.querySelector(".ws.open"));
      await frame();
      const want = ["Insert formula…", "Add source…", "Save", "Save as…"];
      if (JSON.stringify(offered()) !== JSON.stringify(want)) return "the menu offers " + JSON.stringify(offered());
      const menu = document.querySelector(".pop-menu").getBoundingClientRect();
      return menu.right <= innerWidth && menu.bottom <= innerHeight ? "" : "the menu runs off the window";
    `,
  },
  {
    name: "Insert formula… opens on the selected column, and an expression the engine cannot read is refused in the form",
    script: `
      ${RIGHT_CLICK}
      choose("Insert formula…");
      await frame();
      const form = document.querySelector(".formula");
      if (form === null) return "no form opened";
      if (document.querySelector(".pop-menu") !== null) return "the menu stayed open";
      const column = form.querySelector("select");
      const headers = [...column.options].map((o) => o.textContent);
      const want = ["date", "region", "rep", "channel", "units", "revenue"];
      if (JSON.stringify(headers) !== JSON.stringify(want)) return "the form offers " + JSON.stringify(headers);
      const selected = text("#status-cell").split(" · ")[0];
      if (headers[Number(column.value)] !== selected) return "the form opened on " + headers[Number(column.value)] + ", not " + selected;
      if (document.activeElement !== form.querySelector("input")) return "the keys are not in the expression";

      column.value = "${CHANNEL}";
      column.dispatchEvent(new Event("change", { bubbles: true }));
      form.querySelector("input").value = "revenue *";
      form.requestSubmit();
      const note = form.querySelector(".note");
      if (!(await arrives(() => note.classList.contains("err")))) return "the form says " + JSON.stringify(note.textContent);
      if (!note.textContent.includes("revenue *")) return "the refusal is " + JSON.stringify(note.textContent);
      if (!form.isConnected) return "the refused form closed";
      return document.querySelector("thead .badge.bound") === null ? "" : "a refused formula bound a column";
    `,
  },
  {
    name: "a formula computes the column in transform, as one edit, and the header says what from",
    shot: "sidebar-formula",
    script: `
      const form = document.querySelector(".formula");
      form.querySelector("input").value = "revenue * 2";
      form.requestSubmit();
      if (!(await arrives(() => !form.isConnected))) return "the form says " + JSON.stringify(form.querySelector(".note").textContent);
      if (text("#status-msg") !== "channel is computed from revenue * 2") return "the status bar says " + JSON.stringify(text("#status-msg"));
      if (text("#status-mode") !== "TRANSFORM") return "the mode is " + text("#status-mode");
      const badge = document.querySelectorAll("thead th")[GUTTER + ${CHANNEL}].querySelector(".badge.bound");
      if (badge === null) return "channel has no formula badge";
      if (badge.title !== "= revenue * 2") return "the badge says " + JSON.stringify(badge.title);
      // Row 1's revenue is 48160.00.
      const cell = () => document.querySelectorAll("tbody tr")[0].children[GUTTER + ${CHANNEL}].textContent;
      if (!(await arrives(() => cell() === "96320"))) return "row 1 of channel is " + JSON.stringify(cell());
      if (document.querySelector('.tab[data-source="sales-q3"] .dirty') === null) return "the tab has no dirty dot";
      return document.querySelector(".ws.open .dirty") === null ? "the workspace has no dirty dot" : "";
    `,
  },
  {
    name: "the × over unsaved edits says so, and closes nothing",
    script: `
      const close = document.querySelector("#close");
      const at = close.getBoundingClientRect();
      if (Math.round(innerWidth - at.right) > 12 || at.top > 12) return "the × is at " + Math.round(at.left) + "," + Math.round(at.top);
      if (at.width !== at.height || getComputedStyle(close).borderRadius !== "999px") return "the × is not a circle";
      // The × has its corner to itself: scrolled to the end, the last header
      // ends before it.
      const scroller = document.querySelector(".grid-scroll");
      scroller.scrollLeft = scroller.scrollWidth;
      await frame();
      const last = [...document.querySelectorAll("thead th .colhead")].at(-1).getBoundingClientRect();
      scroller.scrollLeft = 0;
      if (last.right > at.left) return "the last header runs under the ×";
      close.click();
      await frame();
      const want = "unsaved edits · Ctrl+S first, or × again to drop them";
      return text("#status-msg") === want ? "" : "the × says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "Ctrl+Z takes the formula back, and the column shows what it stored",
    script: `
      await press("z", { ctrlKey: true });
      if (!(await arrives(() => document.querySelector("thead .badge.bound") === null))) return "the badge stayed";
      const cell = () => document.querySelectorAll("tbody tr")[0].children[GUTTER + ${CHANNEL}].textContent;
      return (await arrives(() => cell() === "direct")) ? "" : "row 1 of channel is " + JSON.stringify(cell());
    `,
  },
  {
    name: "a right click on another workspace offers to open it or take it off the list, and it goes",
    script: `
      ${RIGHT_CLICK}
      rightClick(document.querySelector(".ws:not(.open)"));
      await frame();
      const want = ["Open", "Insert formula…", "Remove from list"];
      if (JSON.stringify(offered()) !== JSON.stringify(want)) return "the menu offers " + JSON.stringify(offered());
      choose("Remove from list");
      await frame();
      if (document.querySelector(".pop-menu") !== null) return "the menu stayed open";
      const left = names(".ws");
      return JSON.stringify(left) === JSON.stringify(["sales-q3"]) ? "" : "the list holds " + JSON.stringify(left);
    `,
  },
];
