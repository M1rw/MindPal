import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const TEMPLATE_PATH = path.join(FRONTEND_DIR, "index.template.html");
const OUTPUT_PATH = path.join(FRONTEND_DIR, "index.html");

const INCLUDE_REGEX = /<!--\s*include\s+([\w\/\.\-]+)\s*-->/g;

function assembleHtml(templatePath, visited = new Set()) {
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

try {
  const result = assembleHtml(TEMPLATE_PATH);
  fs.writeFileSync(OUTPUT_PATH, result, "utf-8");
  console.log(`Successfully assembled HTML to ${path.relative(ROOT, OUTPUT_PATH)}`);
} catch (err) {
  console.error("Failed to assemble HTML:", err);
  process.exit(1);
}
