import test from "node:test";
import assert from "node:assert/strict";
import { machineOf, bareId, shortFolder, folderName, sessionName, cleanPaneTitle } from "../helpers.js";
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
    tabs: { namers: [], remote: false, unknown_key: 1 },
    cleanup: { enabled: true },
  });
  assert.deepEqual(settings.tabs.namers, []);
  assert.equal(settings.tabs.remote, false);
  assert.equal(settings.cleanup.enabled, true);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown_key/);
});
