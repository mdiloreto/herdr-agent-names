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

test("buildPrompt neutralizes @ attachments and includes pane metadata", () => {
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
      },
    ],
  });
  assert.match(prompt, /Space: Dotfiles/);
  assert.match(prompt, /Typed name: herdr fix/);
  assert.match(prompt, /fix ＠home\/file/);
  assert.doesNotMatch(prompt, /@home/);
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
