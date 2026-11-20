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

// What the agent called its session: the herdr-core `claude.title` label (or
// `pi.session` for pi), else a terminal OSC title that says more than the
// terminal's own address, program name/key, path, or user@host.
export function sessionName(p, labels) {
  const termLabels = labels.get(p.terminal);
  const label = termLabels?.["claude.title"] || (p.program?.key === "pi" ? termLabels?.["pi.session"] : null);
  if (label && label.trim()) return label.trim();
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
    title.includes("@")
  ) return null;
  return title;
}

export function cleanPaneTitle(p, session) {
  if (session) return null;
  const raw = (p.title ?? "").trim();
  const bare = bareId(p.terminal);
  if (!raw || raw === p.terminal || (bare && raw === bare)) return null;
  return raw;
}

export function same(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}
