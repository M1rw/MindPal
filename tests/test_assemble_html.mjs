import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assembleHtml } from "../scripts/assemble_html.mjs";

test("assembleHtml - resolves standard includes correctly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindpal-test-html-"));
  try {
    const frontendDir = path.join(tmpDir, "frontend");
    const componentsDir = path.join(frontendDir, "components");
    fs.mkdirSync(componentsDir, { recursive: true });

    const headerPath = path.join(componentsDir, "header.html");
    fs.writeFileSync(headerPath, "<header>My Header</header>", "utf-8");

    const templatePath = path.join(frontendDir, "index.template.html");
    fs.writeFileSync(
      templatePath,
      "<html><body><!-- include components/header.html --></body></html>",
      "utf-8"
    );

    // assembleHtml resolves paths relative to frontend/ directory in repo.
    // Let's test standard assembleHtml on actual frontend/index.template.html
    const assembled = assembleHtml();
    assert.ok(assembled.includes("<header"), "Assembled HTML should include header tag");
    assert.ok(assembled.includes("MindPal"), "Assembled HTML should include MindPal text");
    assert.ok(!assembled.includes("<!-- include components/header.html -->"), "Assembled HTML should replace include comments");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("assembleHtml - throws error on circular includes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindpal-circ-test-"));
  try {
    const fileA = path.join(tmpDir, "a.html");
    fs.writeFileSync(fileA, "<!-- include " + fileA + " -->", "utf-8");

    assert.throws(
      () => assembleHtml(fileA),
      /Circular include detected/,
      "Should throw error when circular include is detected"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
