// Loads and validates mod.json `settings` merged over defaults.
// Pure helpers plus an async loader that takes { readTextFile, appHome }.

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000 };

export const DEFAULT_SETTINGS = {
  pane_heads: {
    enabled: true,
  },
  tabs: {
    enabled: true,
    remote: true,
    rename_window: "10m",
    namers: ["claude", "opencode", "agy"],
    claude_model: "haiku",
    agy_model: "gemini-3.8-flash-low",
    opencode_models: [],
    opencode_free_models_file: "",
  },
  cleanup: {
    enabled: false,
    stale_after: "24h",
    check_every: "5m",
    log_path: ".local/state/herdr-tab-cleanup.log",
  },
};

export function parseDuration(value, fallback) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : fallback;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/i.exec(String(value ?? ""));
  if (!match) return fallback;
  const ms = Number(match[1]) * UNITS[match[2].toLowerCase()];
  return ms > 0 ? ms : fallback;
}

export function dirFromImportMeta(metaUrl) {
  if (typeof metaUrl !== "string" || !metaUrl.startsWith("file://")) return null;
  try {
    const clean = decodeURIComponent(metaUrl.slice(7).split(/[?#]/)[0]);
    const slash = clean.lastIndexOf("/");
    return slash > 0 ? clean.slice(0, slash) : slash === 0 ? "/" : null;
  } catch {
    return null;
  }
}

function mergeSection(defaults, raw, section, problems) {
  const out = { ...defaults };
  if (raw === undefined) return out;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${section} must be an object`);
    return out;
  }
  for (const [key, val] of Object.entries(raw)) {
    if (!(key in defaults)) {
      problems.push(`unknown setting ${section}.${key}`);
      continue;
    }
    const expected = defaults[key];
    if (Array.isArray(expected)) {
      if (Array.isArray(val) && val.every((x) => typeof x === "string")) out[key] = [...val];
      else problems.push(`${section}.${key} must be an array of strings`);
    } else if (typeof expected === "boolean") {
      if (typeof val === "boolean") out[key] = val;
      else problems.push(`${section}.${key} must be a boolean`);
    } else if (typeof expected === "string") {
      if (typeof val === "string" || typeof val === "number") out[key] = val;
      else problems.push(`${section}.${key} must be a string`);
    }
  }
  return out;
}

export function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export function mergeSettings(raw) {
  const problems = [];
  if (raw == null) return { settings: cloneDefaults(), problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: cloneDefaults(), problems: ["settings must be an object"] };
  }
  const settings = {};
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_SETTINGS)) problems.push(`unknown section ${key}`);
  }
  for (const section of Object.keys(DEFAULT_SETTINGS)) {
    settings[section] = mergeSection(DEFAULT_SETTINGS[section], raw[section], section, problems);
  }
  return { settings, problems };
}

export async function loadModSettings({ readTextFile, appHome, metaUrl }) {
  const candidates = [
    dirFromImportMeta(metaUrl),
    `${appHome()}/mods/herdr-agent-names`,
    `${appHome()}/mods/agent-names`,
  ].filter(Boolean);

  for (const dir of [...new Set(candidates)]) {
    const text = await readTextFile(`${dir}/mod.json`).catch(() => null);
    if (text == null) continue;
    try {
      const manifest = JSON.parse(text);
      return { modDir: dir, ...mergeSettings(manifest?.settings) };
    } catch (e) {
      return {
        modDir: dir,
        settings: cloneDefaults(),
        problems: [`invalid mod.json: ${e?.message ?? e}`],
      };
    }
  }
  return {
    modDir: candidates[0] ?? `${appHome()}/mods/herdr-agent-names`,
    settings: cloneDefaults(),
    problems: [],
  };
}
