import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".vite",
  "artifacts",
  ".codex",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
]);
const ignoredFiles = new Set([
  ".tauri-build.err.log",
  ".tauri-build.out.log",
  ".codex-orchestra-vite.err.log",
  ".codex-orchestra-vite.out.log",
]);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:xai|kimi|moonshot|openai)[_-]?(?:api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"`]+/gi,
  /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{12,}/gi,
];
const personalPatterns = [
  /C:\\Users\\lenov\b/gi,
  /\/Users\/lenov\b/gi,
  /D:\\Códigos\\Codex Orchestra/gi,
];
const fixtureAllow = [
  "sk-abcdefghijklmnopqrstuvwxyz",
  "Bearer [fixture-bearer]",
  "users\\\\lenov",
  "users\\lenov",
];

const findings = [];

function isProbablyText(filePath) {
  return !/\.(png|jpe?g|gif|webp|ico|icns|exe|dll|pdb|woff2?|ttf|lock)$/i.test(
    filePath,
  );
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || ignoredFiles.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target);
      continue;
    }
    if (!isProbablyText(target) || statSync(target).size >= 1_000_000) continue;
    const contents = readFileSync(target, "utf8");
    const relative = path.relative(root, target);
    const allowed = fixtureAllow.some((token) => contents.includes(token));
    for (const pattern of secretPatterns) {
      if (pattern.test(contents) && !allowed) {
        findings.push(`${relative}: secret-like token`);
      }
      pattern.lastIndex = 0;
    }
    for (const pattern of personalPatterns) {
      if (pattern.test(contents)) findings.push(`${relative}: personal path`);
      pattern.lastIndex = 0;
    }
  }
}

walk(root);
if (findings.length) {
  console.error(
    "Potential secret-like or personal material found:\n" +
      [...new Set(findings)].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    "No secret-like values or personal machine paths found in workspace files.",
  );
}
