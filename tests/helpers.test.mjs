import test from "node:test";
import assert from "node:assert/strict";
import {
  machineOf,
  bareId,
  shortFolder,
  folderName,
  isCliInvocation,
  sessionName,
  cleanPaneTitle,
  extractScreenExcerpt,
} from "../helpers.js";
import { mergeSettings, parseDuration, dirFromImportMeta } from "../settings.js";

test("machineOf and bareId parse local and remote terminal addresses", () => {
  assert.equal(machineOf("192.168.88.251/t3p"), "192.168.88.251");
  assert.equal(bareId("192.168.88.251/t3p"), "t3p");
  assert.equal(machineOf("t17"), null);
  assert.equal(bareId("t17"), "t17");
  assert.equal(machineOf(null), null);
  assert.equal(bareId(null), null);
});

test("shortFolder and folderName respect remote per-machine home directories", () => {
  assert.equal(shortFolder("/home/mateod", "/home/mateod"), "~");
  assert.equal(shortFolder("/home/mateod/vscode/app", "/home/mateod"), "~/vscode/app");
  assert.equal(shortFolder("/home/mateod/vscode/app", "/Users/mateo"), "/home/mateod/vscode/app");
  assert.equal(shortFolder("/home/mateod/vscode/app", null), "/home/mateod/vscode/app");

  assert.equal(folderName("/home/mateod", "/home/mateod"), "~");
  assert.equal(folderName("/home/mateod/vscode/whatsapp-agent-gateway", "/home/mateod"), "whatsapp-agent-gateway");
  assert.equal(folderName("/home/mateod", null), "mateod");
});

test("sessionName filters terminal-address fallbacks, program names/keys, paths and user@host", () => {
  const labels = new Map([
    ["192.168.88.251/t3p", {}],
    ["192.168.88.251/t99", { "claude.title": "Fix remote autotitles" }],
    ["t20", { "pi.session": "Refactor auth" }],
  ]);

  assert.equal(
    sessionName({ terminal: "192.168.88.251/t3p", title: "192.168.88.251/t3p", program: { agent: true, key: "claude", name: "Claude Code" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t6h", title: "⠋ 192.168.88.251/t6h", program: { agent: true, key: "antigravity", name: "Antigravity" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t62", title: "t62", program: { agent: true, key: "antigravity", name: "Antigravity" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "t17", title: "t17", program: { agent: true, key: "claude", name: "Claude Code" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t62", title: "antigravity", program: { agent: true, key: "antigravity", name: "Antigravity" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t3p", title: "Claude Code", program: { agent: true, key: "claude", name: "Claude Code" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t3p", title: "mateo@arch:~", program: { agent: true, key: "claude", name: "Claude Code" } }, labels),
    null,
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t5x", title: "✳ Update X profile and pinned post", program: { agent: true, key: "claude", name: "Claude Code" } }, labels),
    "Update X profile and pinned post",
  );
  assert.equal(
    sessionName({ terminal: "192.168.88.251/t99", title: "192.168.88.251/t99", program: { agent: true, key: "claude", name: "Claude Code" } }, labels),
    "Fix remote autotitles",
  );
  assert.equal(
    sessionName({ terminal: "t20", title: "t20", program: { agent: true, key: "pi", name: "Pi" } }, labels),
    "Refactor auth",
  );
});

test("cleanPaneTitle drops terminal addresses and bare IDs", () => {
  assert.equal(cleanPaneTitle({ terminal: "192.168.88.251/t3p", title: "192.168.88.251/t3p" }, null), null);
  assert.equal(cleanPaneTitle({ terminal: "192.168.88.251/t3p", title: "t3p" }, null), null);
  assert.equal(cleanPaneTitle({ terminal: "192.168.88.251/t3p", title: "vim main.js" }, null), "vim main.js");
  assert.equal(cleanPaneTitle({ terminal: "192.168.88.251/t3p", title: "vim main.js" }, "active session"), null);
});

test("settings parsing validates durations, merges overrides and reports problems", () => {
  assert.equal(parseDuration("10m", 1), 600000);
  assert.equal(parseDuration("24h", 1), 86400000);
  assert.equal(parseDuration("bad", 42), 42);
  assert.equal(dirFromImportMeta("file:///tmp/mods/herdr-agent-names/main.js"), "/tmp/mods/herdr-agent-names");

  const { settings, problems } = mergeSettings({
    tabs: { namers: [], remote: false, read_screen: false, unknown_key: 1 },
    cleanup: { enabled: true },
  });
  assert.deepEqual(settings.tabs.namers, []);
  assert.equal(settings.tabs.remote, false);
  assert.equal(settings.tabs.read_screen, false);
  assert.equal(settings.cleanup.enabled, true);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown_key/);

  const defaults = mergeSettings({});
  assert.equal(defaults.settings.tabs.read_screen, true);
});

test("sessionName checks herdr-core labels in priority order: agent.title > session.title > claude.title > pi.session", () => {
  const labels = new Map([
    ["t1", { "agent.title": "From agent", "session.title": "From session", "claude.title": "From claude", "pi.session": "From pi" }],
    ["t2", { "agent.title": "   ", "session.title": "From session", "claude.title": "From claude" }],
    ["t3", { "claude.title": "From claude", "pi.session": "From pi" }],
    ["t4", { "pi.session": "From pi" }],
  ]);

  assert.equal(sessionName({ terminal: "t1", program: { agent: true, key: "pi", name: "Pi" } }, labels), "From agent");
  assert.equal(sessionName({ terminal: "t2", program: { agent: true, key: "claude", name: "Claude Code" } }, labels), "From session");
  assert.equal(sessionName({ terminal: "t3", program: { agent: true, key: "pi", name: "Pi" } }, labels), "From claude");
  assert.equal(sessionName({ terminal: "t4", program: { agent: true, key: "pi", name: "Pi" } }, labels), "From pi");
  assert.equal(sessionName({ terminal: "t4", program: { agent: true, key: "codex", name: "Codex" } }, labels), null);
});

test("isCliInvocation identifies raw agent CLI command lines while keeping real titles", () => {
  assert.equal(isCliInvocation("agy --dangerously-skip-permissions", { key: "antigravity", name: "Antigravity" }), true);
  assert.equal(isCliInvocation("claude --resume abc-123", { key: "claude", name: "Claude Code" }), true);
  assert.equal(isCliInvocation("codex --no-daemon", { key: "codex", name: "Codex" }), true);
  assert.equal(isCliInvocation("omp --continue", { key: "oh-my-pi", name: "oh-my-pi" }), true);
  assert.equal(isCliInvocation("kiro-cli chat --trust-all-tools", { key: "kiro", name: "Kiro" }), true);
  assert.equal(isCliInvocation("agy", null), true);
  assert.equal(isCliInvocation("/usr/local/bin/claude --resume", null), true);
  assert.equal(isCliInvocation("⠋ agy --dangerously-skip-permissions", { key: "antigravity" }), true);
  assert.equal(isCliInvocation("myagent --flag", { key: "myagent" }), true);
  assert.equal(isCliInvocation("myagent -c", { key: "myagent" }), true);
  assert.equal(isCliInvocation("myagent", { key: "myagent" }), true);

  assert.equal(isCliInvocation("Update X profile and pinned post", { key: "claude" }), false);
  assert.equal(isCliInvocation("vim main.js", null), false);
  assert.equal(isCliInvocation("vim main.js", { key: "vim" }), false);
  assert.equal(isCliInvocation("claude auth refactor", { key: "claude" }), false);
  assert.equal(isCliInvocation("pi - fix login", { key: "pi" }), false);
  assert.equal(isCliInvocation("", { key: "claude" }), false);
});

test("sessionName and cleanPaneTitle both reject raw CLI invocations", () => {
  const labels = new Map();
  const agyPane = {
    terminal: "192.168.88.251/t62",
    title: "agy --dangerously-skip-permissions",
    program: { agent: true, key: "antigravity", name: "Antigravity" },
  };
  const claudePane = {
    terminal: "t17",
    title: "claude --resume 42",
    program: { agent: true, key: "claude", name: "Claude Code" },
  };
  const codexPane = {
    terminal: "t18",
    title: "codex --no-daemon",
    program: { agent: true, key: "codex", name: "Codex" },
  };

  assert.equal(sessionName(agyPane, labels), null);
  assert.equal(cleanPaneTitle(agyPane, null), null);
  assert.equal(sessionName(claudePane, labels), null);
  assert.equal(cleanPaneTitle(claudePane, null), null);
  assert.equal(sessionName(codexPane, labels), null);
  assert.equal(cleanPaneTitle(codexPane, null), null);
});

test("extractScreenExcerpt cleans oh-my-pi boxes, ANSI escapes, icons, spinners, timestamps and deduplicates", () => {
  const screenText = [
    "\x1b]0;oh-my-pi\x07",
    "╭──────────────────────────────────────────────────────╮",
    "│ \x1b[38;5;208m──── SITE: Simplifica el diseño estilo Mateo.build ─\x1b[0m │",
    "╰──────────────────────────────────────────────────────╯",
    "⠋",
    "✳",
    "14:32:05",
    "2026-11-20 14:32:05",
    "12s",
    "│ \uE0B0\uF07B Updating hero layout and typography \u{F0123} │",
    "│ \uE0B0\uF07B Updating hero layout and typography \u{F0123} │",
    "························",
    "│ • Reviewing mobile spacing • │",
  ].join("\n");

  const excerpt = extractScreenExcerpt({ code: 0, stdout: JSON.stringify({ text: screenText }) });
  assert.equal(
    excerpt,
    "SITE: Simplifica el diseño estilo Mateo.build | Updating hero layout and typography | Reviewing mobile spacing",
  );
});

test("extractScreenExcerpt enforces maxChars keeping the last informative lines and handles invalid input", () => {
  const lines = [
    "Older context line that should be dropped first",
    "Second recent line about OAuth migration",
    "Newest line fixing refresh token expiry",
  ].join("\n");

  const capped = extractScreenExcerpt({ code: 0, stdout: JSON.stringify({ text: lines }) }, 85);
  assert.equal(
    capped,
    "Second recent line about OAuth migration | Newest line fixing refresh token expiry",
  );
  assert.ok(capped.length <= 85);

  const singleLong = extractScreenExcerpt(
    { code: 0, stdout: JSON.stringify({ text: "x".repeat(600) }) },
    50,
  );
  assert.equal(singleLong.length, 50);

  assert.equal(extractScreenExcerpt(null), "");
  assert.equal(extractScreenExcerpt({ code: 1, stdout: JSON.stringify({ text: "hello" }) }), "");
  assert.equal(extractScreenExcerpt({ code: 0, stdout: "not json" }), "");
  assert.equal(extractScreenExcerpt({ code: 0, stdout: JSON.stringify({ text: "───\n⠋\n12:34\n" }) }), "");
});
