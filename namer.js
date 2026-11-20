// Tab naming: a configurable chain of tool-less namers, each tried only when
// the previous one fails, with a deterministic rule fallback that needs no LLM.
// Pure helpers plus a factory that takes host functions (exec, home, ...) as `env`,
// so this module imports nothing from "herdr" and loads directly under node.

import { STALE_SUFFIX } from "./cleanup.js";

export const MAX_NAME = 32;
const MAX_REPLY_LINE = 40;
const FREE_MODELS_TRIED = 2;
const MODEL_FAILED_MS = 60 * 60 * 1000;
const FIELD_MAX = 200;

const OPENCODE_ENV = (namerDir) => [
  "-u", "OPENCODE_CONFIG", "-u", "OPENCODE_CONFIG_DIR", "-u", "OPENCODE_CONFIG_CONTENT",
  `XDG_CONFIG_HOME=${namerDir}/.xdg`,
  "OPENCODE_DISABLE_CLAUDE_CODE=1",
  "OPENCODE_DISABLE_PROJECT_CONFIG=1",
];

const EDGE = /^[\s"'`“”‘’]+|[\s"'`“”‘’.,;:!?…]+$/g;
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

function cut(s, n) {
  const out = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

function unmark(s) {
  while (s.endsWith(STALE_SUFFIX)) s = s.slice(0, -STALE_SUFFIX.length).replace(EDGE, "");
  return s;
}

export function sanitize(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  s = unmark(s.replace(INVISIBLE, "").replace(/\s+/g, " ").replace(EDGE, ""));
  if (s.length > MAX_NAME) {
    const head = s.slice(0, MAX_NAME + 1);
    const at = head.lastIndexOf(" ");
    s = unmark((at > 0 ? head.slice(0, at) : cut(s, MAX_NAME)).replace(EDGE, ""));
  }
  return s;
}

export function cleanReply(raw) {
  if (typeof raw !== "string") return "";
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0]?.trim() ?? "";
  if (lines.length !== 1 || first.length > MAX_REPLY_LINE || /[<*]/.test(raw) || /^#+\s/.test(first) || /\b(?:name|title)\s*:/i.test(first)) return "";
  return sanitize(raw);
}

// Pane text is untrusted. "@" becomes a fullwidth lookalike because CLI agents
// can treat "@path" in a prompt as a file attachment.
function flat(v, max = FIELD_MAX) {
  return String(v).replace(/\s+/g, " ").trim().slice(0, max).replaceAll("@", "＠");
}

// info: { space, typed, panes: [{ program, shell, status, session, step, folder, folderName, branch, title, screen }] }
export function buildPrompt(info) {
  const lines = [`Space: ${flat(info.space)}`];
  if (info.typed) lines.push(`Typed name: ${flat(info.typed)}`);
  info.panes.forEach((p, i) => {
    const parts = [p.shell ? "shell" : flat(p.program)];
    if (p.status) parts.push(flat(p.status));
    if (p.session) parts.push(`session "${flat(p.session)}"`);
    else if (p.title) parts.push(`title "${flat(p.title)}"`);
    if (p.step) parts.push(`step "${flat(p.step)}"`);
    if (p.folder) parts.push(`folder ${flat(p.folder)}`);
    if (p.branch) parts.push(`branch ${flat(p.branch)}`);
    if (p.screen) {
      const excerpt = flat(p.screen, 480);
      if (excerpt) parts.push(`screen "${excerpt}"`);
    }
    lines.push(`Pane ${i + 1}: ${parts.join(", ")}`);
  });
  return lines.join("\n");
}

// Deterministic fallback: what the panes already say about themselves.
export function ruleName(info) {
  const names = info.panes.map((p) => p.session || (p.shell ? null : p.program)).filter(Boolean);
  const joined = sanitize([...new Set(names)].join(" · "));
  return joined || sanitize(info.panes.find((p) => p.folderName)?.folderName ?? "");
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function strictJsonObject(stdout) {
  const text = stdout.trim();
  return parseObject(text) ?? parseObject(text.split("\n").reverse().find((l) => l.trim().startsWith("{")) ?? "");
}

function lastJsonObject(stdout) {
  const text = stdout.trim();
  return strictJsonObject(text) ?? parseObject(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

export function parseAgy(stdout) {
  const out = lastJsonObject(stdout);
  return out?.status === "SUCCESS" ? cleanReply(out.response) : "";
}

export function parseOpencode(stdout) {
  let text = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === "text" && typeof ev.part?.text === "string") text = ev.part.text;
  }
  return cleanReply(text);
}

export function parseClaude(stdout) {
  const out = lastJsonObject(stdout);
  return out && !out.is_error ? cleanReply(out.result) : "";
}

export function typedName(tab, { owned, pending, typed, seen }) {
  if (!tab.named || tab.name === owned || tab.name === pending) return null;
  if (seen !== undefined && seen !== tab.name) return { restart: true };
  if (tab.name === typed) return null;
  return { restart: owned != null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function agyConversationPaths(home, stdout) {
  const id = strictJsonObject(stdout)?.conversation_id;
  if (typeof id !== "string" || !UUID.test(id)) return [];
  const base = `${home}/.gemini/antigravity-cli`;
  return [
    ...[".db", ".db-wal", ".db-shm"].map((e) => `${base}/conversations/${id}${e}`),
    `${base}/presence/${id}.lock`,
    `${base}/brain/${id}`,
    `${base}/annotations/${id}.pbtxt`,
  ];
}

export function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? md.slice(m[0].length) : md).trim();
}

class NoName extends Error {}

function resolvePath(path, userHome) {
  if (!path) return "";
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return `${userHome}${path.slice(1)}`;
  return path.startsWith("/") ? path : `${userHome}/${path}`;
}

export function createNamer(env) {
  const failedUntil = new Map();
  let rules = null;
  const dir = () => `${env.modDir()}/namer`;
  const config = () => env.config?.() ?? {};

  async function run(command, args, timeout, parse, after, on) {
    const opts = on ? { on, timeout } : { cwd: dir(), timeout };
    const r = await env.exec(command, args, opts);
    await after?.(r);
    if (r.code !== 0) throw new Error(`exit ${r.code}`);
    const name = parse(r.stdout);
    if (!name) throw new NoName("no name");
    return name;
  }

  async function forgetConversation(r) {
    const paths = agyConversationPaths(env.home(), r.stdout);
    if (!paths.length) {
      if (r.code === 0) env.log?.("agy conversation id not found; files kept");
      return;
    }
    try {
      await env.exec("rm", ["-rf", "--", ...paths], { timeout: 5000 });
    } catch (e) {
      env.log?.(`agy conversation not deleted: ${e?.message ?? e}`);
    }
  }

  function parseAgyOrFail(stdout) {
    const name = parseAgy(stdout);
    if (!name && lastJsonObject(stdout)?.status !== "SUCCESS") throw new Error("agy status not SUCCESS");
    return name;
  }

  const agy = (prompt) =>
    run(
      "agy",
      [
        "--agent", "tab-namer",
        "--model", config().agy_model || "gemini-3.8-flash-low",
        "--disable-slash-commands",
        "--print-timeout", "40s",
        "--output-format", "json",
        "-p", prompt,
      ],
      45000,
      parseAgyOrFail,
      forgetConversation,
    );

  const cooling = (id) => (failedUntil.get(id) ?? 0) > env.now();
  const cool = (id) => failedUntil.set(id, env.now() + MODEL_FAILED_MS);

  async function opencodeModels() {
    const explicit = (config().opencode_models ?? []).filter((id) => id && !cooling(id));
    if (explicit.length) return explicit.slice(0, FREE_MODELS_TRIED);
    const file = resolvePath(config().opencode_free_models_file, env.home());
    if (!file) return [];
    const text = await env.readTextFile(file).catch(() => null);
    if (!text) return [];
    let models = {};
    try {
      models = JSON.parse(text).models ?? {};
    } catch {
      return [];
    }
    const nowSec = env.now() / 1000;
    return Object.entries(models)
      .filter(([id, m]) => (m?.cooldown_until ?? 0) <= nowSec && !cooling(id))
      .sort(([, a], [, b]) => (b?.last_ok ?? 0) - (a?.last_ok ?? 0))
      .map(([id]) => id)
      .slice(0, FREE_MODELS_TRIED);
  }

  async function opencode(prompt) {
    const models = await opencodeModels();
    if (!models.length) throw new Error("no opencode models configured");
    for (const model of models) {
      try {
        return await run(
          "env",
          [
            ...OPENCODE_ENV(dir()),
            "opencode", "run", "--standalone",
            "--agent", "tab-namer",
            "--title", "tab-namer",
            "-m", model,
            "--format", "json",
            prompt,
          ],
          40000,
          parseOpencode,
        );
      } catch (e) {
        if (!(e instanceof NoName)) cool(model);
      }
    }
    throw new Error("no opencode model answered");
  }

  async function claude(prompt, on) {
    rules ??= stripFrontmatter((await env.readTextFile(`${dir()}/.agents/agents/tab-namer.md`)) ?? "");
    if (!rules) throw new Error("no rules");
    return run(
      "claude",
      [
        "-p", "--safe-mode", "--tools", "", "--strict-mcp-config",
        "--no-chrome", "--no-session-persistence",
        "--setting-sources", "",
        "--settings", '{"disableAllHooks":true}',
        "--model", config().claude_model || "haiku",
        "--output-format", "json",
        "--system-prompt", rules,
        prompt,
      ],
      45000,
      parseClaude,
      null,
      on,
    );
  }

  const providers = { agy, opencode, claude };

  return async function inferName(prompt, fallback, { on } = {}) {
    const order = config().namers ?? ["claude", "opencode", "agy"];
    for (const by of order) {
      const namer = providers[by];
      if (!namer || cooling(by)) continue;
      try {
        return { name: await namer(prompt), by };
      } catch (e) {
        if (!(e instanceof NoName) && by !== "opencode") cool(by);
      }
    }
    if (on && order.length) {
      const remoteKey = `${on}:claude`;
      if (!cooling(remoteKey)) {
        try {
          return { name: await claude(prompt, on), by: remoteKey };
        } catch (e) {
          if (!(e instanceof NoName)) cool(remoteKey);
        }
      }
    }
    return { name: fallback, by: "rule" };
  };
}
