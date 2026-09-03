import fs from "fs";
import path from "path";
import assert from "assert";

const htmlPath = path.resolve("frontend/index.html");
const html = fs.readFileSync(htmlPath, "utf-8");

const keysToVerify = [
  "Enable dictation",
  "Response complete",
  "Streak reminders",
  "Mood check-in"
];

for (const key of keysToVerify) {
  const pattern = new RegExp(`<span class="settings-row-title">${key}</span>`, "g");
  const matches = html.match(pattern) || [];
  assert.strictEqual(
    matches.length,
    1,
    `Control title "${key}" appeared ${matches.length} times in index.html, expected exactly 1.`
  );
}

console.log("Settings deduplication contract test passed cleanly!");
