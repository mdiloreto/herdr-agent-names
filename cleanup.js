// Empty shell tabs: marked " · stale" when found, closed once they stay empty
// for staleAfterMs. Local spaces only — never closes tabs on remote machines.
// Imports nothing from "herdr"; the host functions arrive as `env`.

export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CLEANUP_EVERY_MS = 5 * 60 * 1000;
export const STALE_KEY = "agent-names.stale";
export const STALE_SUFFIX = " · stale";
export const DEFAULT_LOG_PATH = ".local/state/herdr-tab-cleanup.log";

// tabs: [{ id, name, named, space }]; emptyIds: Set of tab ids that are empty now;
// stale: { tabId: { since, checked, base, named } }; tabCountBySpace: { spaceId: n }.
export function planCleanup({
  tabs,
  emptyIds,
  stale,
  now,
  focusedTab,
  tabCountBySpace,
  staleMs = DEFAULT_STALE_MS,
  checkEveryMs = DEFAULT_CLEANUP_EVERY_MS,
}) {
  const maxUncheckedMs = 3 * checkEveryMs;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const counts = { ...tabCountBySpace };
  const plan = { mark: [], unmark: [], close: [], reset: [], drop: [] };

  for (const [id, entry] of Object.entries(stale)) {
    const tab = byId.get(id);
    if (!tab) plan.drop.push(id);
    else if (!emptyIds.has(id) || tab.name !== entry.base + STALE_SUFFIX) {
      // Used again, or a person renamed it: give the name back only if it is still ours.
      plan.unmark.push({
        id,
        base: entry.base,
        named: entry.named !== false,
        rename: tab.name === entry.base + STALE_SUFFIX,
      });
    } else if (now - (entry.checked ?? 0) > maxUncheckedMs) {
      plan.reset.push(id);
    } else if (entry.since + staleMs <= now && counts[tab.space] > 1 && id !== focusedTab) {
      plan.close.push(id);
      counts[tab.space]--;
    }
  }
  for (const id of emptyIds) {
    const tab = byId.get(id);
    if (!tab || stale[id]) continue;
    const marked = tab.name.endsWith(STALE_SUFFIX);
    const base = marked ? tab.name.slice(0, -STALE_SUFFIX.length) : tab.name;
    plan.mark.push({ id, base, named: tab.named, rename: !marked });
  }
  return plan;
}

// Cheap pre-check before reading screens: every pane is an idle shell with no
// agent. It does not mean nothing ever ran there; the screen read decides that.
export function isQuiet(mine, terminals) {
  return (
    mine.length > 0 &&
    mine.every((p) => {
      const t = p.terminal && p.program?.shell ? terminals.get(p.terminal) : null;
      return t && t.turn === 0 && !t.report && !t.labels?.["claude.session"] && (t.status ?? null) === null;
    })
  );
}

// `hc read --json` of a shell nobody used: the screen is complete (no older
// output missing) and shows exactly one line, the prompt. Anything else
// (history, a failed read, a blank screen) is not empty.
export function screenIsEmpty(result) {
  if (result?.code !== 0) return false;
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (out?.complete !== true || typeof out.text !== "string") return false;
  return out.text.split("\n").filter((l) => l.trim()).length === 1;
}

export async function runCleanup(env) {
  const staleMs = env.staleMs ?? DEFAULT_STALE_MS;
  const checkEveryMs = env.checkEveryMs ?? DEFAULT_CLEANUP_EVERY_MS;
  const logPath = env.logPath ?? DEFAULT_LOG_PATH;
  const byAddress = new Map(env.terminals().map((t) => [t.address, t]));
  const spaces = env.spaces().filter((s) => s.machine == null);
  const allPanes = env.panes();
  const tabs = spaces.flatMap((s) => s.tabs.map((t) => ({ id: t.id, name: t.name, named: t.named, space: s.id })));
  if (!tabs.length || !allPanes.length || !byAddress.size) return { notEmpty: new Set() };

  const emptyIds = new Set();
  const notEmpty = new Set();
  for (const tab of tabs) {
    const mine = allPanes.filter((p) => p.tab === tab.id);
    if (!isQuiet(mine, byAddress)) continue;
    let empty = true;
    for (const p of mine) {
      const read = await env.hc(["read", p.terminal, "--json", "--lines", "20"]).catch(() => null);
      await env.touch();
      if (!screenIsEmpty(read)) empty = false;
    }
    (empty ? emptyIds : notEmpty).add(tab.id);
  }

  const stale = env.shared(STALE_KEY) ?? {};
  const now = env.now();
  const tabCountBySpace = Object.fromEntries(spaces.map((s) => [s.id, s.tabs.length]));
  const plan = planCleanup({
    tabs,
    emptyIds,
    stale,
    now,
    focusedTab: env.focused()?.tab ?? null,
    tabCountBySpace,
    staleMs,
    checkEveryMs,
  });

  const freshTab = (id) => {
    const space = env.spaces().find((s) => s.tabs.some((t) => t.id === id));
    return { space, tab: space?.tabs.find((t) => t.id === id) };
  };
  const closed = [];
  const closable = (id) => {
    const { space, tab } = freshTab(id);
    const gone = closed.filter((c) => space?.tabs.some((t) => t.id === c)).length;
    if (!tab || space.machine != null || !tab.name.endsWith(STALE_SUFFIX) || env.focused()?.tab === id || space.tabs.length - gone <= 1) return false;
    const terminals = new Map(env.terminals().map((t) => [t.address, t]));
    return isQuiet(env.panes().filter((p) => p.tab === id), terminals);
  };

  const logged = new Set();
  for (const id of plan.close) {
    if (!closable(id)) continue;
    const space = spaces.find((s) => s.tabs.some((t) => t.id === id));
    const folder = allPanes.find((p) => p.tab === id)?.cwd ?? "";
    try {
      await appendLog(env, logPath, `${new Date(now).toISOString()}\t${space.name}\t${stale[id].base}\t${folder}\n`);
      logged.add(id);
    } catch (e) {
      env.log?.(`tab-cleanup kept ${id}: log failed: ${e?.message ?? e}`);
    }
    await env.touch();
  }

  const cur = env.shared(STALE_KEY) ?? {};
  const next = { ...cur };
  for (const id of Object.keys(stale)) if (next[id]) next[id] = { ...next[id], checked: now };
  for (const id of plan.drop) delete next[id];
  for (const id of plan.reset) if (next[id]) next[id].since = now;
  for (const { id } of plan.unmark) delete next[id];
  for (const id of plan.close) {
    if (logged.has(id) && closable(id)) {
      closed.push(id);
      delete next[id];
    }
  }
  const nameNow = (id) => freshTab(id).tab?.name;
  const renames = [];
  for (const { id, base, named, rename } of plan.mark) {
    const snapshot = tabs.find((t) => t.id === id).name;
    if (nameNow(id) !== snapshot) continue;
    next[id] = { since: now, checked: now, base, named };
    if (rename) renames.push([id, base + STALE_SUFFIX]);
  }
  for (const { id, base, named, rename } of plan.unmark) {
    if (rename && nameNow(id) === base + STALE_SUFFIX) renames.push([id, named ? base : ""]);
  }
  env.setShared(STALE_KEY, next);
  for (const [id, name] of renames) env.rename(id, name);
  for (const id of closed) {
    env.run("tab.close", { id, confirmed: true });
    env.log?.(`tab-cleanup closed ${id} (${stale[id].base})`);
  }
  return { notEmpty };
}

async function appendLog(env, logPath, line) {
  const path = logPath.startsWith("/") ? logPath : `${env.home()}/${logPath}`;
  const old = await env.readTextFile(path);
  await env.writeTextFile(path, (old ?? "") + line, old);
}
