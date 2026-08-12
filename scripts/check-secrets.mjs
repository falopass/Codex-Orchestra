import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", "dist", "target", ".vite"]);
const suspicious = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:xai|kimi|moonshot|openai)[_-]?(?:api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"`]+/gi,
  /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{12,}/gi,
];
const findings = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (statSync(target).size < 1_000_000) {
      const contents = readFileSync(target, "utf8");
      for (const pattern of suspicious) {
        if (pattern.test(contents)) findings.push(target);
        pattern.lastIndex = 0;
      }
    }
  }
}

walk(root);
if (findings.length) {
  console.error(
    "Potential secret-like material found:",
    [...new Set(findings)].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log("No secret-like values found in tracked workspace files.");
}
