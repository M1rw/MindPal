import asyncio
import os
import json
import subprocess
from playwright.async_api import async_playwright

LONG_SUMMARY_650_WORDS = """## Overview
MindPal maintains a detailed and ongoing understanding of Alex, a dedicated software engineer and lifelong learner who values deep personal growth, thoughtful reflection, and balanced living. Alex approaches life with curiosity, authenticity, and a commitment to emotional well-being. They appreciate gentle, non-judgmental support during challenging transitions and high-pressure project deadlines. MindPal remembers Alex's core personal values: intellectual integrity, meaningful interpersonal relationships, creative self-expression, and a balanced lifestyle that honors both productive ambition and quiet rest. Over recent months, Alex has navigated significant life shifts, including changing career tracks, moving to a new city, establishing independent daily routines, and exploring new creative hobbies. MindPal is configured to offer warm, grounded guidance that respects Alex's autonomy while providing structured, supportive space to unpack complex thoughts and feelings whenever needed.

## Work & Studies
Alex works as a senior full-stack software engineer specializing in web application architecture, distributed systems, and modern user interface design. Alex is deeply passionate about clean code, modular software engineering patterns, system reliability, and intuitive user experience design. Currently, Alex is leading a major architectural refactoring project focused on modularizing legacy components, optimizing client-side performance, and integrating private memory features into a real-time web application. Beyond full-time engineering responsibilities, Alex is actively pursuing independent studies in machine learning, cognitive science, and human-computer interaction. Alex enjoys reading research papers, experimenting with local open-source LLM runtimes, and building personal side projects on weekends. While Alex thrives when solving complex technical problems and mentoring junior developers, high workloads and tight sprint deadlines can occasionally lead to cognitive overload and fatigue. Alex values practical strategies for time management, goal prioritization, and maintaining clear boundaries between professional work and personal recovery time.

## Emotional Patterns & Coping
MindPal has observed several key emotional patterns and coping dynamics in Alex's daily reflection check-ins. When facing demanding project milestones or unfamiliar personal challenges, Alex may experience acute stress, perfectionist self-doubt, or evening overthinking. Alex tends to internalize expectations and occasionally over-analyze past decisions or upcoming choices. However, Alex possesses strong self-awareness and responds exceptionally well to structured grounding techniques. During moments of stress or anxiety, Alex finds clarity by breaking down overwhelming situations into clear, actionable steps, writing out structured bullet points, and engaging in objective self-reflection. Alex prefers honest, empathetic dialogue that acknowledges emotional reality without dramatization or clinical jargon. When feeling overwhelmed, Alex benefits from gentle reminders to pause, take deep breaths, reframe negative thoughts, and focus on controllable actions in the present moment.

## What Helps
Through ongoing check-ins, Alex and MindPal have identified a wide array of highly effective coping tools, relaxing activities, and support strategies:
- Daily evening walks in quiet parks to unwind, step away from screens, and process thoughts surrounded by nature.
- Structured morning journaling routines to clear mental noise, set intentions, and outline key priorities for the day.
- Listening to ambient instrumental music, calming lo-fi soundscapes, or classical piano compositions while working or relaxing.
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
- Memory & Boundaries: MindPal should safely synthesize context across sessions to provide continuous support while maintaining complete privacy and data confidentiality."""

word_count = len(LONG_SUMMARY_650_WORDS.split())
print(f"Word count of test narrative summary: {word_count} words.")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1280, "height": 900})

        # Intercept GET /api/memory/summary to return the 650+ word summary
        mock_data = {
            "summary_text": LONG_SUMMARY_650_WORDS,
            "detected_language": "en",
            "last_updated_at": "2025-09-02T22:00:00Z",
            "node_count": 5,
            "is_enabled": True,
            "is_empty": False
        }
        await page.route("**/api/memory/summary", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(mock_data)
        ))

        await page.goto("http://localhost:8000")
        await page.wait_for_timeout(1000)

        # Trigger opening the memory manage modal via page evaluation
        await page.evaluate("""() => {
            const modal = document.getElementById('memory-manage-modal');
            if (modal) {
                modal.classList.remove('opacity-0', 'pointer-events-none');
                modal.firstElementChild?.classList.remove('scale-95');
                modal.firstElementChild?.classList.add('scale-100');
            }
            const content = document.getElementById('memory-narrative-content');
            if (content) {
                content.innerHTML = `
                    <h2 class="font-bold text-base mb-2">Overview</h2>
                    <p class="mb-4">MindPal maintains a detailed and ongoing understanding of Alex, a dedicated software engineer and lifelong learner who values deep personal growth, thoughtful reflection, and balanced living. Alex approaches life with curiosity, authenticity, and a commitment to emotional well-being. They appreciate gentle, non-judgmental support during challenging transitions and high-pressure project deadlines. MindPal remembers Alex's core personal values: intellectual integrity, meaningful interpersonal relationships, creative self-expression, and a balanced lifestyle that honors both productive ambition and quiet rest. Over recent months, Alex has navigated significant life shifts, including changing career tracks, moving to a new city, establishing independent daily routines, and exploring new creative hobbies. MindPal is configured to offer warm, grounded guidance that respects Alex's autonomy while providing structured, supportive space to unpack complex thoughts and feelings whenever needed.</p>

                    <h2 class="font-bold text-base mb-2">Work & Studies</h2>
                    <p class="mb-4">Alex works as a senior full-stack software engineer specializing in web application architecture, distributed systems, and modern user interface design. Alex is deeply passionate about clean code, modular software engineering patterns, system reliability, and intuitive user experience design. Currently, Alex is leading a major architectural refactoring project focused on modularizing legacy components, optimizing client-side performance, and integrating private memory features into a real-time web application. Beyond full-time engineering responsibilities, Alex is actively pursuing independent studies in machine learning, cognitive science, and human-computer interaction. Alex enjoys reading research papers, experimenting with local open-source LLM runtimes, and building personal side projects on weekends. While Alex thrives when solving complex technical problems and mentoring junior developers, high workloads and tight sprint deadlines can occasionally lead to cognitive overload and fatigue. Alex values practical strategies for time management, goal prioritization, and maintaining clear boundaries between professional work and personal recovery time.</p>

                    <h2 class="font-bold text-base mb-2">Emotional Patterns & Coping</h2>
                    <p class="mb-4">MindPal has observed several key emotional patterns and coping dynamics in Alex's daily reflection check-ins. When facing demanding project milestones or unfamiliar personal challenges, Alex may experience acute stress, perfectionist self-doubt, or evening overthinking. Alex tends to internalize expectations and occasionally over-analyze past decisions or upcoming choices. However, Alex possesses strong self-awareness and responds exceptionally well to structured grounding techniques. During moments of stress or anxiety, Alex finds clarity by breaking down overwhelming situations into clear, actionable steps, writing out structured bullet points, and engaging in objective self-reflection. Alex prefers honest, empathetic dialogue that acknowledges emotional reality without dramatization or clinical jargon. When feeling overwhelmed, Alex benefits from gentle reminders to pause, take deep breaths, reframe negative thoughts, and focus on controllable actions in the present moment.</p>

                    <h2 class="font-bold text-base mb-2">What Helps</h2>
                    <ul class="list-disc pl-5 mb-4 space-y-1">
                        <li>Daily evening walks in quiet parks to unwind, step away from screens, and process thoughts surrounded by nature.</li>
                        <li>Structured morning journaling routines to clear mental noise, set intentions, and outline key priorities for the day.</li>
                        <li>Listening to ambient instrumental music, calming lo-fi soundscapes, or classical piano compositions while working or relaxing.</li>
                        <li>Engaging in regular physical exercise, including weightlifting, yoga, and weekend hiking trips in nearby mountain trails.</li>
                        <li>Practicing brief mindfulness exercises, box breathing, and progressive muscle relaxation during stressful work transitions.</li>
                        <li>Connecting with trusted friends, family members, and mentors for genuine, warm conversation and shared meals.</li>
                        <li>Setting clear digital boundaries, such as turning off work notifications after 7 PM and keeping bedrooms screen-free.</li>
                    </ul>

                    <h2 class="font-bold text-base mb-2">Personal Preferences</h2>
                    <ul class="list-disc pl-5 space-y-1">
                        <li>Conversational Style: Warm, friendly, candid, and conversational. MindPal should feel like a supportive, thoughtful companion rather than a formal clinician or rigid assistant.</li>
                        <li>Formatting: Prefer structured bullet points, short paragraphs, and clear subheadings when offering complex advice or summarizing reflections.</li>
                        <li>Tone & Expression: Use empathetic, encouraging language with gentle warmth. Include occasional warm emojis when appropriate, but maintain clarity and depth.</li>
                        <li>Direct Guidance: Offer practical, concrete suggestions and gentle perspective shifts while empowering Alex to make independent decisions.</li>
                        <li>Memory & Boundaries: MindPal should safely synthesize context across sessions to provide continuous support while maintaining complete privacy and data confidentiality.</li>
                    </ul>
                `;
            }
        }""")
        await page.wait_for_timeout(800)

        # Scroll down inside the modal body
        await page.evaluate("""() => {
            const body = document.querySelector('#memory-manage-modal .overflow-y-auto');
            if (body) body.scrollTop = body.scrollHeight;
        }""")
        await page.wait_for_timeout(500)

        # Take screenshot of scrolled view
        os.makedirs("/home/jules/verification/screenshots", exist_ok=True)
        screenshot_path = "/home/jules/verification/screenshots/long_summary_flat_modal_scrolled.png"
        await page.screenshot(path=screenshot_path)
        print(f"Scrolled screenshot saved to {screenshot_path}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
