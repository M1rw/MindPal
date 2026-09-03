import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const LONG_SUMMARY_650_WORDS = `## Overview
MindPal maintains a detailed and ongoing understanding of Alex, a dedicated software engineer and lifelong learner who values deep personal growth, thoughtful reflection, and balanced living. Alex approaches life with curiosity, authenticity, and a commitment to emotional well-being. They appreciate gentle, non-judgmental support during challenging transitions and high-pressure project deadlines. MindPal remembers Alex's core personal values: intellectual integrity, meaningful interpersonal relationships, creative self-expression, and a balanced lifestyle that honors both productive ambition and quiet rest. Over recent months, Alex has navigated significant life shifts, including changing career tracks, moving to a new city, establishing independent daily routines, and exploring new creative hobbies. MindPal is configured to offer warm, grounded guidance that respects Alex's autonomy while providing structured, supportive space to unpack complex thoughts and feelings whenever needed.

## Work & Studies
Alex works as a senior full-stack software engineer specializing in web application architecture, distributed systems, and modern user interface design. Alex is deeply passionate about clean code, modular software engineering patterns, system reliability, and intuitive user experience design. Currently, Alex is leading a major architectural refactoring project focused on modularizing legacy components, optimizing client-side performance, and integrating private memory features into a real-time web application. Beyond full-time engineering responsibilities, Alex is actively pursuing independent studies in machine learning, cognitive science, and human-computer interaction. Alex enjoys reading research papers, experimenting with local open-source LLM runtimes, and building personal side projects on weekends. While Alex thrives when solving complex technical problems and mentoring junior developers, high workloads and tight sprint deadlines can occasionally lead to cognitive overload and fatigue. Alex values practical strategies for time management, goal prioritization, and maintaining clear boundaries between professional work and personal recovery time.

## Emotional Patterns & Coping
MindPal has observed several key emotional patterns and coping dynamics in Alex's daily reflection check-ins. When facing demanding project milestones or unfamiliar personal challenges, Alex may experience acute stress, perfectionist self-doubt, or evening overthinking. Alex tends to internalize expectations and occasionally over-analyze past decisions or upcoming choices. However, Alex possesses strong self-awareness and responds exceptionally well to structured grounding techniques. During moments of stress or anxiety, Alex finds clarity by breaking down overwhelming situations into clear, actionable steps, writing out structured bullet points, and engaging in objective self-reflection. Alex prefers honest, empathetic dialogue that acknowledges emotional reality without dramatization or clinical jargon. When feeling overwhelmed, Alex benefits from gentle reminders to pause, take deep breaths, reframe negative thoughts, and focus on controllable actions in the present moment.

## What Helps
Through ongoing check-ins, Alex and MindPal have identified a wide array of highly effective coping tools, relaxing activities, and support strategies:
- Daily evening walks in quiet parks to unwind, step away from screens, and process thoughts surrounded by nature.
- Structured morning journaling routines to clear mental noise, set intentions, and outline key priorities for the day.
- Listening to ambient instrumental music, classical piano compositions, or calming lo-fi soundscapes while working or relaxing.
- Engaging in regular physical exercise, including weightlifting, yoga, and weekend hiking trips in nearby mountain trails.
- Practicing brief mindfulness exercises, box breathing, and progressive muscle relaxation during stressful work transitions.
- Connecting with trusted friends, family members, and mentors for genuine, warm conversation and shared meals.
- Setting clear digital boundaries, such as turning off work notifications after 7 PM and keeping bedrooms screen-free.

## Personal Preferences
Alex has established clear communication and interaction preferences for MindPal:
- Conversational Style: Warm, friendly, candid, and conversational. MindPal should feel like a supportive, thoughtful companion rather than a formal clinician or rigid assistant.
- Formatting: Prefer structured bullet points, short paragraphs, and clear subheadings when offering complex advice or summarizing reflections.
- Tone & Expression: Use empathetic, encouraging language with gentle warmth. Include occasional warm emojis when appropriate, but maintain clarity and depth.
- Direct Guidance: Offer practical, concrete suggestions and gentle perspective shifts while empowering Alex to make independent decisions.
- Memory & Boundaries: MindPal should safely synthesize context across sessions to provide continuous support while maintaining complete privacy and data confidentiality.`;

const wordCount = LONG_SUMMARY_650_WORDS.split(/\s+/).length;
console.log(`Word count of test narrative summary: ${wordCount} words.`);

async function main() {
  const env = { ...process.env, PYTHONPATH: "." };
  const proc = spawn("uv", ["run", "python", "-m", "backend.main"], { env });

  await new Promise((r) => setTimeout(r, 3000));

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await page.goto("http://localhost:8000");
    await page.waitForTimeout(1000);

    // Update memory summary via PUT endpoint
    const status = await page.evaluate(async (summary) => {
      const r = await fetch("/api/memory/summary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: summary, action: "update" }),
      });
      return r.status;
    }, LONG_SUMMARY_650_WORDS);

    console.log(`PUT memory response status: ${status}`);

    // Open settings modal
    await page.evaluate(() => {
      window.MINDPAL.openModal("profile-modal", "profile-content");
    });
    await page.waitForTimeout(500);

    // Open Memory manage modal
    await page.click("#open-memory-modal-btn");
    await page.waitForTimeout(800);

    // Take screenshot
    const screenshotDir = "/home/jules/verification/screenshots";
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, "long_summary_flat_modal.png");
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to ${screenshotPath}`);

    // Check rendered content verbatim
    const content = await page.innerText("#memory-narrative-content");
    console.log(`Rendered narrative character count in DOM: ${content.length}`);

    if (!content.includes("Alex approaches life with curiosity")) {
      throw new Error("Missing Overview content!");
    }
    if (!content.includes("Setting clear digital boundaries")) {
      throw new Error("Missing What Helps content!");
    }
    if (!content.includes("maintaining complete privacy and data confidentiality")) {
      throw new Error("Missing Personal Preferences ending content!");
    }

    console.log("Verbatim long-summary rendering test PASSED cleanly!");

    await browser.close();
  } finally {
    proc.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
