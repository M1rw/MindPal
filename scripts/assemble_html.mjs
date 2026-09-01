import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const COMPONENTS_DIR = path.join(FRONTEND_DIR, "components");
const TEMPLATE_PATH = path.join(FRONTEND_DIR, "index.template.html");
const OUTPUT_PATH = path.join(FRONTEND_DIR, "index.html");

const INCLUDE_REGEX = /<!--\s*include\s+([\w\/\.\-]+)\s*-->/g;

export function assembleHtml(templatePath = TEMPLATE_PATH, visited = new Set()) {
  if (visited.has(templatePath)) {
    throw new Error(`Circular include detected: ${templatePath}`);
  }
  visited.add(templatePath);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  let content = fs.readFileSync(templatePath, "utf-8");

  content = content.replace(INCLUDE_REGEX, (match, relPath) => {
    const componentPath = path.resolve(FRONTEND_DIR, relPath);
    return assembleHtml(componentPath, new Set(visited));
  });

  return content;
}

export function runBuild() {
  const result = assembleHtml(TEMPLATE_PATH);
  fs.writeFileSync(OUTPUT_PATH, result, "utf-8");
  console.log(`Successfully assembled HTML to ${path.relative(ROOT, OUTPUT_PATH)}`);
  return result;
}

// CLI Execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const isWatch = process.argv.includes("--watch");

  try {
    runBuild();
  } catch (err) {
    console.error("Failed to assemble HTML:", err);
    if (!isWatch) {
      process.exit(1);
    }
  }

  if (isWatch) {
    console.log("Watching HTML template and components for changes...");
    let debounceTimer = null;
    const triggerRebuild = (filename) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          console.log(`[HTML Watcher] File changed: ${filename}. Reassembling HTML...`);
          runBuild();
        } catch (err) {
          console.error("Failed to re-assemble HTML:", err);
        }
      }, 100);
    };

    if (fs.existsSync(TEMPLATE_PATH)) {
      fs.watch(TEMPLATE_PATH, (eventType, filename) => triggerRebuild(filename || "index.template.html"));
    }

    if (fs.existsSync(COMPONENTS_DIR)) {
      fs.watch(COMPONENTS_DIR, { recursive: true }, (eventType, filename) => triggerRebuild(filename));
    }
  }
}
