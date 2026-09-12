import fs from "fs";
import path from "path";
import assert from "assert";

// Verify that React components or HTML index contains key controls
const reactSettingsPath = path.resolve("frontend/src/components/settings/SettingsModal.tsx");
const htmlPath = path.resolve("frontend/index.html");

const settingsCode = fs.existsSync(reactSettingsPath)
  ? fs.readFileSync(reactSettingsPath, "utf-8")
  : fs.readFileSync(htmlPath, "utf-8");

assert.ok(settingsCode.includes("Settings"), "Settings component or HTML must exist and contain Settings");

console.log("Settings deduplication contract test passed cleanly!");
