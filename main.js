// Herdr App mod: names pane headers and tabs (local and remote) from what
// their coding agents and panes are working on, with optional empty-shell
// cleanup. Runs as a zero-size block in a Herdr App layout.
import { View, div } from "gpui-kit";
import {
  panes, spaces, terminals, shared, setShared, run, home, appHome, exec, hc, focused,
  readTextFile, writeTextFile, checking,
} from "herdr";
import { machineOf, shortFolder, folderName, sessionName, sessionCwd, cleanPaneTitle, extractScreenExcerpt, same } from "./helpers.js";
import { cloneDefaults, loadModSettings, parseDuration } from "./settings.js";
import { buildPrompt, createNamer, ruleName, typedName } from "./namer.js";
import { DEFAULT_CLEANUP_EVERY_MS, DEFAULT_STALE_MS, isQuiet, runCleanup, STALE_KEY, STALE_SUFFIX } from "./cleanup.js";

const OWNED_TABS = "agent-names.tabs";
const TYPED_TABS = "agent-names.typed";
const NAMED_TABS = "agent-names.named";
const BY = "agent-names";
const DEFAULT_RENAME_WINDOW_MS = 10 * 60 * 1000;
const QUEUE_POLL_MS = 3000;

export default class AgentNames extends View {
  init(_props, cx) {
    this.settings = cloneDefaults();
    this.modDir = `${appHome()}/mods/herdr-agent-names`;
    this.pending = new Map();
    this.queue = new Map();
    this.seen = new Map();
    this.gen = new Map();
    this.busyShells = new Set();
    // Per-machine $HOME: undefined = lookup in flight, string = resolved, null = unavailable.
    this.homes = new Map();
    this.busy = false;
    this.cleaning = false;
    this.lastCleanupAt = 0;

    if (checking()) return;

    this.inferName = createNamer({
      exec,
      home,
      modDir: () => this.modDir,
      config: () => this.settings.tabs,
      readTextFile,
      now: () => Date.now(),
      log: (m) => console.log(`agent-names: ${m}`),
    });

    cx.spawn(async (cx) => {
      const { modDir, settings, problems } = await loadModSettings({
        readTextFile,
        appHome,
        metaUrl: import.meta.url,
      });
      this.modDir = modDir;
      this.settings = settings;
      for (const problem of problems) console.warn(`agent-names mod.json settings: ${problem}`);
      if (this.settings.cleanup.enabled) this.cleanup(cx);
      cx.notify();
    });

    cx.timer.every(QUEUE_POLL_MS, (cx) => {
      this.drainQueue(cx);
      if (this.settings.cleanup.enabled) {
        const every = parseDuration(this.settings.cleanup.check_every, DEFAULT_CLEANUP_EVERY_MS);
        if (Date.now() - this.lastCleanupAt >= every) this.cleanup(cx);
      }
    });
  }

  homeFor(address, cx) {
    const machine = machineOf(address);
    if (!machine) return home();
    if (this.homes.has(machine)) return this.homes.get(machine);
    if (checking()) {
      this.homes.set(machine, null);
      return null;
    }
    this.homes.set(machine, undefined);
    cx.spawn(async (cx) => {
      let dir = null;
      try {
        const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine, timeout: 5000 });
        const out = result.code === 0 ? result.stdout.trim().replace(/\\/g, "/") : "";
        if (out) dir = out;
      } catch {
        // Offline or non-POSIX shell; fall back to raw path / basename.
      }
      this.homes.set(machine, dir);
      cx.notify();
    });
    return undefined;
  }

  render(cx) {
    const labels = new Map(terminals().map((t) => [t.address, t.labels ?? {}]));
    const every = panes();
    if (this.settings.pane_heads.enabled) {
      this.syncPaneHeads(every.filter((p) => p.terminal), labels, cx);
    }
    if (this.settings.tabs.enabled) {
      this.syncTabNames(every, labels, cx);
    }
    return div().id("agent-names").size(0);
  }

  syncPaneHeads(all, labels, cx) {
    const heads = shared("pane-heads") ?? {};
    const next = Object.fromEntries(Object.entries(heads).filter(([, head]) => head?.by !== BY));
    for (const p of all) {
      const name = sessionName(p, labels);
      if (!name || next[p.pane]) continue;
      const ctx = labels.get(p.terminal)?.["claude.ctx"];
      const cwd = sessionCwd(p, labels);
      const userHome = this.homeFor(p.terminal, cx);
      next[p.pane] = { by: BY, title: name, detail: [ctx, shortFolder(cwd, userHome)].filter(Boolean).join(" · ") };
    }
    if (!same(heads, next)) setShared("pane-heads", next);
  }

  rename(id, name) {
    if (name) this.pending.set(id, name);
    else this.pending.delete(id);
    run("tab.rename", { id, name });
  }

  tabInfo(space, mine, typed, labels, reports, cx) {
    return {
      space: space.name,
      typed: typed ?? null,
      panes: mine.map((p) => {
        const session = sessionName(p, labels);
        const cwd = sessionCwd(p, labels);
        const userHome = this.homeFor(p.terminal, cx);
        return {
          program: p.program?.name ?? "",
          shell: !!p.program?.shell,
          status: p.status ?? null,
          session,
          step: reports.get(p.terminal) ?? null,
          folder: shortFolder(cwd, userHome),
          folderName: folderName(cwd, userHome),
          branch: p.branch ?? null,
          title: cleanPaneTitle(p, session),
        };
      }),
    };
  }

  syncTabNames(every, labels, cx) {
    const spaceList = spaces();
    const tlist = terminals();
    if (!spaceList.some((s) => s.tabs.length) || !every.some((p) => p.terminal) || !tlist.length) return;
    const now = Date.now();
    const renameWindowMs = parseDuration(this.settings.tabs.rename_window, DEFAULT_RENAME_WINDOW_MS);
    const owned = shared(OWNED_TABS) ?? {};
    const typed = shared(TYPED_TABS) ?? {};
    const stale = shared(STALE_KEY) ?? {};
    const named = shared(NAMED_TABS) ?? {};
    const tmap = new Map(tlist.map((t) => [t.address, t]));
    const reports = new Map(tlist.map((t) => [t.address, t.report?.msg ?? null]));
    const live = new Set(spaceList.flatMap((s) => s.tabs.map((t) => t.id)));
    const keep = (m) => Object.fromEntries(Object.entries(m).filter(([id]) => live.has(id)));
    const nextOwned = keep(owned);
    const nextTyped = keep(typed);
    const nextNamed = keep(named);

    for (const space of spaceList) {
      if (space.machine != null && !this.settings.tabs.remote) continue;
      for (const tab of space.tabs) {
        const pending = this.pending.get(tab.id);
        if (pending && tab.name === pending) {
          nextOwned[tab.id] = pending;
          this.pending.delete(tab.id);
        }
        const inTab = every.filter((p) => p.tab === tab.id);
        const mine = inTab.filter((p) => p.terminal);
        if (!mine.length) continue;
        const found = typedName(tab, {
          owned: nextOwned[tab.id],
          pending: this.pending.get(tab.id),
          typed: typed[tab.id],
          seen: this.seen.get(tab.id),
        });
        this.seen.set(tab.id, tab.name);
        if (found) {
          nextTyped[tab.id] = tab.name;
          if (found.restart) {
            nextNamed[tab.id] = { fp: nextNamed[tab.id]?.fp ?? null, at: now };
            this.queue.delete(tab.id);
            this.gen.set(tab.id, (this.gen.get(tab.id) ?? 0) + 1);
          }
        }
        if (!tab.named) delete nextTyped[tab.id];
        if (stale[tab.id] || (isQuiet(inTab, tmap) && !this.busyShells.has(tab.id))) {
          this.queue.delete(tab.id);
          continue;
        }
        if (mine.some((p) => this.homeFor(p.terminal, cx) === undefined)) continue;
        const info = this.tabInfo(space, mine, nextTyped[tab.id], labels, reports, cx);
        if (info.typed && !info.typed.endsWith(STALE_SUFFIX) && info.panes.every((p) => p.shell && !p.session && !p.step)) {
          this.queue.delete(tab.id);
          if (tab.name !== info.typed && this.pending.get(tab.id) !== info.typed) this.rename(tab.id, info.typed);
          continue;
        }
        const screenPanes = [];
        if (this.settings.tabs.read_screen) {
          info.panes.forEach((p, index) => {
            if (screenPanes.length >= 2) return;
            if (!p.shell && !p.session && !p.title && !p.step) {
              const terminal = mine[index].terminal;
              const turn = tmap.get(terminal)?.turn ?? 0;
              screenPanes.push({ index, terminal, turn });
            }
          });
        }
        const prompt = buildPrompt(info);
        const turnKey = screenPanes
          .map((sp) => `${sp.terminal}:${sp.turn > 0 ? Math.min(sp.turn, 5) : 0}`)
          .join(",");
        const fp = turnKey ? `${prompt}\n#screen:${turnKey}` : prompt;
        const last = nextNamed[tab.id];
        const genericUpgrade =
          screenPanes.length > 0 &&
          mine.some((p) => p.program?.name && p.program.name === tab.name);
        if (last && (fp === last.fp || (!genericUpgrade && now - last.at < renameWindowMs))) {
          this.queue.delete(tab.id);
          continue;
        }
        if (this.queue.get(tab.id)?.fp === fp) continue;
        const machine = space.machine ?? machineOf(mine[0]?.terminal) ?? null;
        this.queue.set(tab.id, {
          prompt,
          fp,
          info,
          screenPanes,
          machine,
          fallback: ruleName(info),
          gen: this.gen.get(tab.id) ?? 0,
        });
      }
    }
    for (const map of [this.queue, this.seen, this.gen, this.pending]) {
      for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
    }
    for (const id of [...this.busyShells]) if (!live.has(id)) this.busyShells.delete(id);
    if (!same(owned, nextOwned)) setShared(OWNED_TABS, nextOwned);
    if (!same(typed, nextTyped)) setShared(TYPED_TABS, nextTyped);
    if (!same(named, nextNamed)) setShared(NAMED_TABS, nextNamed);
  }

  drainQueue(cx) {
    if (this.busy || !this.queue.size) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        while (this.queue.size) {
          const [id, job] = this.queue.entries().next().value;
          this.queue.delete(id);
          setShared(NAMED_TABS, { ...(shared(NAMED_TABS) ?? {}), [id]: { fp: job.fp, at: Date.now() } });
          let prompt = job.prompt;
          if (job.screenPanes?.length && this.settings.tabs.read_screen) {
            const panesCopy = job.info.panes.map((p) => ({ ...p }));
            let enriched = false;
            for (const sp of job.screenPanes) {
              const read = await hc(["read", sp.terminal, "--json", "--lines", "40"]).catch(() => null);
              await cx.sleep(0);
              const excerpt = extractScreenExcerpt(read);
              if (excerpt && panesCopy[sp.index]) {
                panesCopy[sp.index].screen = excerpt;
                enriched = true;
              }
            }
            if (enriched) {
              prompt = buildPrompt({ ...job.info, panes: panesCopy });
            }
          }
          if ((this.gen.get(id) ?? 0) !== job.gen) continue;
          const { name, by } = await this.inferName(prompt, job.fallback, { on: job.machine });
          await cx.sleep(0);
          this.apply(id, job, name, by);
        }
      } catch (e) {
        console.log(`agent-names: naming failed: ${e?.message ?? e}`);
      } finally {
        this.busy = false;
      }
    });
  }

  apply(id, job, name, by) {
    if ((this.gen.get(id) ?? 0) !== job.gen) return;
    const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === id);
    const stale = shared(STALE_KEY) ?? {};
    setShared(NAMED_TABS, { ...(shared(NAMED_TABS) ?? {}), [id]: { fp: job.fp, at: Date.now() } });
    if (!tab || !name || stale[id] || tab.name.endsWith(STALE_SUFFIX)) return;
    const owned = shared(OWNED_TABS) ?? {};
    if (tab.name === name) {
      if (owned[id] !== name) setShared(OWNED_TABS, { ...owned, [id]: name });
      return;
    }
    console.log(`agent-names: tab ${id} -> "${name}" by ${by}`);
    this.rename(id, name);
  }

  cleanup(cx) {
    if (this.cleaning || !this.settings.cleanup.enabled) return;
    this.cleaning = true;
    this.lastCleanupAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const { notEmpty } = await runCleanup({
          spaces,
          panes,
          terminals,
          focused,
          shared,
          setShared,
          run,
          hc,
          home,
          readTextFile,
          writeTextFile,
          staleMs: parseDuration(this.settings.cleanup.stale_after, DEFAULT_STALE_MS),
          checkEveryMs: parseDuration(this.settings.cleanup.check_every, DEFAULT_CLEANUP_EVERY_MS),
          logPath: this.settings.cleanup.log_path,
          rename: (id, name) => this.rename(id, name),
          now: () => Date.now(),
          log: (m) => console.log(`agent-names: ${m}`),
          touch: () => cx.sleep(0),
        });
        this.busyShells = notEmpty;
      } catch (e) {
        console.log(`agent-names: cleanup failed: ${e?.message ?? e}`);
      } finally {
        this.cleaning = false;
      }
    });
  }
}
