import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const repoRoot = new URL("../", import.meta.url);
const vercelIgnorePath = new URL(".vercelignore", repoRoot);
const legacyRuntimePath = new URL("frontend/js/voice/archive/runtime.legacy.js", repoRoot);

test("Vercel source upload keeps the Voice legacy runtime available to esbuild", () => {
  const ignoreLines = fs.readFileSync(vercelIgnorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());

  assert.ok(fs.existsSync(legacyRuntimePath), "legacy Voice runtime must be tracked in the repository");
  assert.equal(ignoreLines.includes("archive"), false, "a broad archive rule would exclude the Voice runtime");
  assert.equal(ignoreLines.includes("/archive"), true, "only the repository-root archive directory may be ignored");
});

// Keep this file executable under the repository's standard ESM test runner.
void repoRoot;
