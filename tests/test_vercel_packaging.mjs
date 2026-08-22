import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const repoRoot = new URL("../", import.meta.url);
const vercelIgnorePath = new URL(".vercelignore", repoRoot);
const voiceEntryPath = new URL("voice/src/production-entry.ts", repoRoot);

test("Vercel source upload keeps the Voice engine available to esbuild", () => {
  const ignoreLines = fs.readFileSync(vercelIgnorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());

  assert.ok(fs.existsSync(voiceEntryPath), "Voice production entry must be tracked in the repository");
  assert.equal(ignoreLines.includes("archive"), false, "a broad archive rule would exclude frontend files");
  assert.equal(ignoreLines.includes("/archive"), true, "only the repository-root archive directory may be ignored");
});

// Keep this file executable under the repository's standard ESM test runner.
void repoRoot;
