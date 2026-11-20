import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitize,
  cleanReply,
  buildPrompt,
  ruleName,
  parseClaude,
  parseOpencode,
  parseAgy,
  typedName,
  createNamer,
} from "../namer.js";

test("sanitize strips quotes, invisible chars, stale suffix, and truncates on word boundaries", () => {
  assert.equal(sanitize('  "fix remote titles."  '), "fix remote titles");
  assert.equal(sanitize("work · stale"), "work");
  assert.equal(sanitize("a very long tab title that exceeds thirty two characters easily").length <= 32, true);
});

test("cleanReply rejects multi-line or explanatory model output", () => {
  assert.equal(cleanReply("herdr remote titles"), "herdr remote titles");
  assert.equal(cleanReply("Title: herdr remote titles"), "");
  assert.equal(cleanReply("# Heading"), "");
  assert.equal(cleanReply("line one\nline two"), "");
});

test("buildPrompt neutralizes @ attachments and includes pane metadata and screen excerpts", () => {
  const longScreen = `${"a".repeat(250)} @src/app.js ${"b".repeat(300)}`;
  const prompt = buildPrompt({
    space: "Dotfiles",
    typed: "herdr fix",
    panes: [
      {
        program: "Claude Code",
        shell: false,
        status: "working",
        session: "fix @home/file",
        step: "running tests",
        folder: "~/vscode/dotfiles",
        folderName: "dotfiles",
        branch: "fix/remote",
        title: null,
        screen: longScreen,
      },
    ],
  });
  assert.match(prompt, /Space: Dotfiles/);
  assert.match(prompt, /Typed name: herdr fix/);
  assert.match(prompt, /fix ＠home\/file/);
  assert.match(prompt, /screen "a{250} ＠src\/app\.js b{217}"/);
  const screenMatch = prompt.match(/screen "([^"]+)"/);
  assert.ok(screenMatch);
  assert.equal(screenMatch[1].length, 480);
  assert.doesNotMatch(prompt, /@home|@src/);
});

test("ruleName prefers session names, then non-shell programs, then folderName", () => {
  assert.equal(
    ruleName({ panes: [{ shell: false, program: "Claude Code", session: "fix oauth", folderName: "api" }] }),
    "fix oauth",
  );
  assert.equal(
    ruleName({ panes: [{ shell: true, program: "zsh", session: null, folderName: "dotfiles" }] }),
    "dotfiles",
  );
});

test("provider parsers extract clean names from JSON outputs", () => {
  assert.equal(parseClaude(JSON.stringify({ is_error: false, result: "remote tab titles" })), "remote tab titles");
  assert.equal(parseClaude(JSON.stringify({ is_error: true, result: "error" })), "");
  assert.equal(
    parseOpencode([JSON.stringify({ type: "text", part: { text: "opencode title" } })].join("\n")),
    "opencode title",
  );
  assert.equal(parseAgy(JSON.stringify({ status: "SUCCESS", response: "agy title" })), "agy title");
});

test("typedName distinguishes user renames from mod-owned or in-flight names", () => {
  assert.equal(typedName({ named: true, name: "mine" }, { owned: "mine", pending: null, typed: null, seen: "mine" }), null);
  assert.deepEqual(typedName({ named: true, name: "custom" }, { owned: "mine", pending: null, typed: null, seen: "mine" }), { restart: true });
  assert.deepEqual(typedName({ named: true, name: "preexisting" }, { owned: null, pending: null, typed: null, seen: undefined }), { restart: false });
});

test("createNamer falls back through chain and respects zero-LLM rule mode", async () => {
  const calls = [];
  const infer = createNamer({
    exec: async (cmd) => {
      calls.push(cmd);
      return { code: 1, stdout: "", stderr: "not found" };
    },
    home: () => "/tmp",
    modDir: () => "/tmp/mod",
    config: () => ({ namers: ["claude", "agy"], claude_model: "haiku", agy_model: "gemini-3.8-flash-low" }),
    readTextFile: async () => "---\nname: tab-namer\n---\nPrompt body",
    now: () => 1000,
  });

  const res = await infer("Space: Demo\nPane 1: Claude Code", "fallback name");
  assert.deepEqual(res, { name: "fallback name", by: "rule" });
  assert.deepEqual(calls, ["claude", "agy"]);

  // Second call within cooldown skips failed providers directly to rule
  const res2 = await infer("Space: Demo\nPane 1: Claude Code", "fallback name");
  assert.deepEqual(res2, { name: "fallback name", by: "rule" });
  assert.deepEqual(calls, ["claude", "agy"]);
});

test("createNamer passes fast isolated claude flags and falls back to remote claude with separate cooldowns", async () => {
  const calls = [];
  let failRemoteHostA = false;
  let failLocalClaude = true;
  const infer = createNamer({
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === "claude" && !opts.on) {
        if (failLocalClaude) return { code: 1, stdout: "", stderr: "missing locally" };
        return { code: 0, stdout: JSON.stringify({ is_error: false, result: "local task name" }) };
      }
      if (cmd === "claude" && opts.on === "host-a") {
        if (failRemoteHostA) return { code: 1, stdout: "", stderr: "remote error" };
        return { code: 0, stdout: JSON.stringify({ is_error: false, result: "remote mateo design" }) };
      }
      if (cmd === "claude" && opts.on === "host-b") {
        return { code: 0, stdout: JSON.stringify({ is_error: false, result: "host b refactor" }) };
      }
      return { code: 1, stdout: "", stderr: "not found" };
    },
    home: () => "/tmp",
    modDir: () => "/tmp/mod",
    config: () => ({ namers: ["claude", "agy"], claude_model: "haiku", agy_model: "gemini-3.8-flash-low" }),
    readTextFile: async () => "---\nname: tab-namer\n---\nPrompt body",
    now: () => 1000,
  });

  // Local claude + agy fail -> falls back to remote claude on host-a
  const r1 = await infer("Space: Remote\nPane 1: oh-my-pi", "oh-my-pi", { on: "host-a" });
  assert.deepEqual(r1, { name: "remote mateo design", by: "host-a:claude" });
  assert.equal(calls.length, 3);
  const localClaudeCall = calls[0];
  const remoteClaudeCall = calls[2];
  assert.equal(localClaudeCall.opts.cwd, "/tmp/mod/namer");
  assert.equal(localClaudeCall.opts.on, undefined);
  assert.equal(remoteClaudeCall.opts.on, "host-a");
  assert.equal(remoteClaudeCall.opts.cwd, undefined);
  for (const call of [localClaudeCall, remoteClaudeCall]) {
    const srcIdx = call.args.indexOf("--setting-sources");
    assert.ok(srcIdx >= 0 && call.args[srcIdx + 1] === "");
    const setIdx = call.args.indexOf("--settings");
    assert.ok(setIdx >= 0 && call.args[setIdx + 1] === '{"disableAllHooks":true}');
  }

  // Local providers are cooled down, so next remote call goes straight to host-a:claude
  calls.length = 0;
  const r2 = await infer("Space: Remote\nPane 1: oh-my-pi", "oh-my-pi", { on: "host-a" });
  assert.deepEqual(r2, { name: "remote mateo design", by: "host-a:claude" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.on, "host-a");

  // Remote host-a failure cools down host-a:claude without cooling down host-b:claude
  failRemoteHostA = true;
  calls.length = 0;
  const r3 = await infer("Space: Remote\nPane 1: oh-my-pi", "oh-my-pi", { on: "host-a" });
  assert.deepEqual(r3, { name: "oh-my-pi", by: "rule" });
  assert.equal(calls.length, 1);

  // Calling host-a again skips cooled-down host-a:claude directly to rule
  calls.length = 0;
  const r4 = await infer("Space: Remote\nPane 1: oh-my-pi", "oh-my-pi", { on: "host-a" });
  assert.deepEqual(r4, { name: "oh-my-pi", by: "rule" });
  assert.equal(calls.length, 0);

  // Different remote host-b is NOT cooled down
  const r5 = await infer("Space: Remote\nPane 1: Codex", "Codex", { on: "host-b" });
  assert.deepEqual(r5, { name: "host b refactor", by: "host-b:claude" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.on, "host-b");
});

test("createNamer remote failure does not cool down local claude and respects empty namers rule mode", async () => {
  const calls = [];
  let failLocal = false;
  const infer = createNamer({
    exec: async (cmd, _args, opts) => {
      calls.push({ cmd, on: opts.on ?? null });
      if (opts.on) return { code: 1, stdout: "", stderr: "remote claude missing" };
      if (failLocal) return { code: 0, stdout: JSON.stringify({ is_error: false, result: "" }) };
      return { code: 0, stdout: JSON.stringify({ is_error: false, result: "local ok" }) };
    },
    home: () => "/tmp",
    modDir: () => "/tmp/mod",
    config: () => ({ namers: ["claude"], claude_model: "haiku" }),
    readTextFile: async () => "---\nname: tab-namer\n---\nPrompt body",
    now: () => 2000,
  });

  // Local returns NoName (no cooldown), remote fails (cools down remote only)
  failLocal = true;
  const r1 = await infer("Space: Remote\nPane 1: Antigravity", "Antigravity", { on: "host-x" });
  assert.deepEqual(r1, { name: "Antigravity", by: "rule" });
  assert.deepEqual(calls, [{ cmd: "claude", on: null }, { cmd: "claude", on: "host-x" }]);

  // Local claude is still NOT cooled down and answers on the next call
  failLocal = false;
  calls.length = 0;
  const r2 = await infer("Space: Local\nPane 1: Antigravity", "Antigravity", { on: "host-x" });
  assert.deepEqual(r2, { name: "local ok", by: "claude" });
  assert.deepEqual(calls, [{ cmd: "claude", on: null }]);

  // Explicit zero-LLM mode (namers: []) skips remote claude fallback too
  const ruleOnlyCalls = [];
  const ruleOnly = createNamer({
    exec: async (cmd) => {
      ruleOnlyCalls.push(cmd);
      return { code: 0, stdout: "" };
    },
    home: () => "/tmp",
    modDir: () => "/tmp/mod",
    config: () => ({ namers: [] }),
    readTextFile: async () => "---\nname: tab-namer\n---\nPrompt body",
    now: () => 2000,
  });
  const r3 = await ruleOnly("Space: Remote\nPane 1: Codex", "Codex", { on: "host-z" });
  assert.deepEqual(r3, { name: "Codex", by: "rule" });
  assert.deepEqual(ruleOnlyCalls, []);
});
