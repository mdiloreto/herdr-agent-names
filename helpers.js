// Pure helpers for terminal addresses, remote-aware folder names, and agent
// session titles. Imports nothing from "herdr", so this module loads under node.

export function machineOf(address) {
  if (!address) return null;
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

export function bareId(address) {
  if (!address) return null;
  const slash = address.indexOf("/");
  return slash >= 0 ? address.slice(slash + 1) : address;
}

export function shortFolder(cwd, userHome) {
  if (!cwd) return "";
  if (userHome && cwd === userHome) return "~";
  return userHome && cwd.startsWith(`${userHome}/`) ? `~${cwd.slice(userHome.length)}` : cwd;
}

export function folderName(cwd, userHome) {
  if (!cwd) return null;
  if (userHome && cwd === userHome) return "~";
  return cwd.split("/").filter(Boolean).pop() ?? null;
}

// What the agent called its session: herdr-core labels in priority order
// (`agent.title`, `session.title`, `claude.title`, and `pi.session` for pi),
// else a terminal OSC title that says more than the terminal's own address,
// program name/key, raw CLI invocation, path, or user@host.
const AGENT_CLIS = new Set([
  "agy", "antigravity", "claude", "codex", "pi", "omp", "oh-my-pi",
  "gemini", "opencode", "copilot", "crush", "amp", "kimi", "kiro", "kiro-cli",
]);

export function isCliInvocation(title, program) {
  if (typeof title !== "string") return false;
  const cleaned = title.trim().replace(/^[^\p{L}\p{N}/.~]+/u, "").trim();
  if (!cleaned) return false;
  const match = cleaned.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return false;
  const cmd = match[1];
  const rest = (match[2] ?? "").trim();
  const base = cmd.split("/").pop().toLowerCase();
  const key = program?.key?.toLowerCase();
  const isKnown = AGENT_CLIS.has(base) || (Boolean(key) && base === key);
  if (!isKnown) return false;
  if (!rest) return true;
  return /^-{1,2}[A-Za-z0-9]/.test(rest) || /(?:^|\s)--[A-Za-z0-9][\w-]*/.test(rest);
}

export function sessionName(p, labels) {
  const termLabels = labels.get(p.terminal);
  const label = [
    termLabels?.["agent.title"],
    termLabels?.["session.title"],
    termLabels?.["claude.title"],
    p.program?.key === "pi" ? termLabels?.["pi.session"] : null,
  ].find((v) => typeof v === "string" && v.trim());
  if (label) return label.trim();
  if (!p.program?.agent) return null;
  const raw = (p.title ?? "").trim();
  const bare = bareId(p.terminal);
  if (!raw || raw === p.terminal || (bare && raw === bare)) return null;
  const title = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (
    !title ||
    title === p.program.name ||
    title.toLowerCase() === p.program.key?.toLowerCase() ||
    title === p.terminal ||
    (bare && title === bare) ||
    /^[~/]|^[A-Za-z]:\\/.test(title) ||
    title.includes("@") ||
    isCliInvocation(title, p.program)
  ) return null;
  return title;
}

export function cleanPaneTitle(p, session) {
  if (session) return null;
  const raw = (p.title ?? "").trim();
  const bare = bareId(p.terminal);
  if (!raw || raw === p.terminal || (bare && raw === bare)) return null;
  const stripped = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (
    !stripped ||
    stripped === p.terminal ||
    (bare && stripped === bare) ||
    (p.program?.name && stripped === p.program.name) ||
    isCliInvocation(raw, p.program)
  ) return null;
  return raw;
}

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_DCS = /\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\x1b(?:[()#%][0-9A-Za-z]|[@-Z\\-_])/g;
const CTRL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const PUA_ICONS = /[\uE000-\uF8FF\u{F0000}-\u{FFFFF}\u{100000}-\u{10FFFF}]/gu;
const EDGE_BORDERS = /^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•]+|[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•]+$/g;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const TIMESTAMP_ONLY = /^[\[(]?\s*(?:\d{4}[-/]\d{2}[-/]\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|utc|gmt))?|\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:\.\d+)?(?:ms|s|m|h))*)\s*[\])]?$/i;

export function extractScreenExcerpt(result, maxChars = 480) {
  if (maxChars <= 0 || result?.code !== 0 || typeof result.stdout !== "string") return "";
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    return "";
  }
  if (typeof out?.text !== "string") return "";

  const lines = [];
  for (const rawLine of out.text.split(/\r?\n/)) {
    const line = rawLine
      .replace(ANSI_OSC, "")
      .replace(ANSI_DCS, "")
      .replace(ANSI_CSI, "")
      .replace(ANSI_ESC, "")
      .replace(CTRL_CHARS, "")
      .replace(PUA_ICONS, " ")
      .replace(/\t/g, " ")
      .replace(/[ ]+/g, " ")
      .replace(EDGE_BORDERS, "")
      .trim();
    if (!line || !HAS_ALNUM.test(line) || TIMESTAMP_ONLY.test(line)) continue;
    if (lines.length && lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  if (!lines.length) return "";

  const picked = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const sep = picked.length ? 3 : 0;
    if (total + sep + line.length <= maxChars) {
      picked.push(line);
      total += sep + line.length;
    } else {
      if (!picked.length) {
        const cut = line.slice(0, maxChars);
        picked.push((/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trim());
      }
      break;
    }
  }
  return picked.reverse().join(" | ");
}

export function same(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}
