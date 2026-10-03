// Generate worker/.dev.vars from the root .env.
// Which keys to copy comes from worker/.dev.vars.example, so other projects' keys
// in .env are never copied. Values are never printed.
//
// Usage: npm run env:sync   (also runs automatically before `npm run dev`)

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = join(root, ".env");
const EXAMPLE = join(root, "worker/.dev.vars.example");
const OUT = join(root, "worker/.dev.vars");

/** Other names a key may have in .env, checked after the key's own name. */
const ALIASES = { CF_API_TOKEN: ["CF_API_KEY"] };

function parse(file) {
  const vars = new Map();
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(["'])(.*)\1$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
    vars.set(m[1], value);
  }
  return vars;
}

if (!existsSync(ENV)) {
  console.warn(`sync-dev-vars: ${ENV} not found; leaving worker/.dev.vars unchanged.`);
  process.exit(0);
}

const env = parse(ENV);
const current = parse(OUT);
const example = parse(EXAMPLE);

const lines = [];
const report = [];
for (const [key, exampleDefault] of example) {
  const fromEnv = [key, ...(ALIASES[key] ?? [])].find((k) => env.get(k));
  // Priority: .env (or alias) → value already in .dev.vars → example default.
  const value = fromEnv ? env.get(fromEnv) : current.get(key) || exampleDefault;
  const from = fromEnv ? `.env${fromEnv === key ? "" : ` (${fromEnv})`}` : current.get(key) ? "kept" : exampleDefault ? "default" : "";
  lines.push(`${key}=${value}`);
  report.push(`  ${key.padEnd(18)} ${value ? `set   ← ${from}` : "EMPTY"}`);
}

writeFileSync(OUT, `${lines.join("\n")}\n`, { mode: 0o600 });
chmodSync(OUT, 0o600); // mode only applies on create
console.log(`sync-dev-vars: wrote worker/.dev.vars\n${report.join("\n")}`);
