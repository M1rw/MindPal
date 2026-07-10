import fs from "node:fs";

const lockPath = new URL("../package-lock.json", import.meta.url);
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const allowedRegistry = "https://registry.npmjs.org/";
const forbiddenPatterns = [
  /\.internal\./i,
  /localhost/i,
  /127\.0\.0\.1/,
  /artifactory/i,
  /packages\.applied-caas-gateway/i,
];

const invalid = [];
for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
  const resolved = pkg?.resolved;
  if (typeof resolved !== "string") continue;
  if (forbiddenPatterns.some((pattern) => pattern.test(resolved))) {
    invalid.push({ name, resolved, reason: "private/internal registry" });
    continue;
  }
  if (resolved.startsWith("http") && !resolved.startsWith(allowedRegistry)) {
    invalid.push({ name, resolved, reason: "unapproved registry" });
  }
}

if (invalid.length > 0) {
  console.error("package-lock.json contains non-portable registry URLs:");
  for (const item of invalid.slice(0, 20)) {
    console.error(`- ${item.name || "<root>"}: ${item.resolved} (${item.reason})`);
  }
  if (invalid.length > 20) console.error(`...and ${invalid.length - 20} more`);
  process.exit(1);
}

console.log(`Lockfile registry check passed (${Object.keys(lock.packages ?? {}).length} package records).`);
