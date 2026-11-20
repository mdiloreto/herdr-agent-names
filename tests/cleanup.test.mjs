import test from "node:test";
import assert from "node:assert/strict";
import { planCleanup, isQuiet, screenIsEmpty, STALE_SUFFIX } from "../cleanup.js";

test("isQuiet requires shell panes with zero turns and no agent/session state", () => {
  const terms = new Map([
    ["t1", { turn: 0, report: null, labels: {}, status: null }],
    ["t2", { turn: 1, report: null, labels: {}, status: null }],
  ]);
  assert.equal(isQuiet([{ terminal: "t1", program: { shell: true } }], terms), true);
  assert.equal(isQuiet([{ terminal: "t2", program: { shell: true } }], terms), false);
  assert.equal(isQuiet([{ terminal: "t1", program: { shell: false } }], terms), false);
});

test("screenIsEmpty accepts only complete single-line prompt output", () => {
  assert.equal(screenIsEmpty({ code: 0, stdout: JSON.stringify({ complete: true, text: "~/code $ \n\n" }) }), true);
  assert.equal(screenIsEmpty({ code: 0, stdout: JSON.stringify({ complete: true, text: "~/code $ ls\nfile.js\n~/code $ " }) }), false);
  assert.equal(screenIsEmpty({ code: 0, stdout: JSON.stringify({ complete: false, text: "~/code $ " }) }), false);
  assert.equal(screenIsEmpty({ code: 1, stdout: "" }), false);
});

test("planCleanup marks empty tabs, unmarks reused tabs, and never closes focused or last tab", () => {
  const now = 100_000;
  const plan = planCleanup({
    tabs: [
      { id: "tb1", name: "dotfiles", named: true, space: "sp1" },
      { id: "tb2", name: `shell${STALE_SUFFIX}`, named: true, space: "sp1" },
      { id: "tb3", name: `focused${STALE_SUFFIX}`, named: true, space: "sp1" },
    ],
    emptyIds: new Set(["tb1", "tb2", "tb3"]),
    stale: {
      tb2: { since: now - 25 * 3600_000, checked: now - 1000, base: "shell", named: true },
      tb3: { since: now - 25 * 3600_000, checked: now - 1000, base: "focused", named: true },
    },
    now,
    focusedTab: "tb3",
    tabCountBySpace: { sp1: 3 },
  });

  assert.deepEqual(plan.mark.map((m) => m.id), ["tb1"]);
  assert.deepEqual(plan.close, ["tb2"]);
});
