# Adaptive Rich Response System

## Objective

MindPal should present answers with the same clarity users expect from polished modern AI interfaces while keeping the emotional warmth and cognitive simplicity appropriate for wellbeing support. The system therefore treats formatting as a **decision**, not decoration. A short greeting remains plain; a plan becomes a readable list; a real comparison can become a compact table; and verified external material can appear as a recognizable source link.

> **Core rule:** the response shape must reduce cognitive load. If formatting does not make the answer clearer, MindPal should not add it.

## Content-shape policy

| User need | Preferred presentation | Avoid |
|---|---|---|
| Greeting, affirmation, or one-step answer | One to three plain conversational sentences | Headings, tables, decorative callouts |
| Explanation with several ideas | One short heading and compact paragraphs | Dense wall of text or many headings |
| Plan, actions, or options | A short bullet or numbered list | Nested lists and long checklist dumps |
| Comparison with shared criteria | A compact Markdown table | Tables for emotional support or a simple question |
| Key takeaway or copyable script | A restrained blockquote/callout | Multiple callouts or oversized cards |
| Verified external source from a tool | A Markdown link rendered as an icon-bearing source pill | Invented links, citations, or source claims |
| Code or technical example | A fenced code block with optional language label | Inline prose pretending to be code |

## Implemented presentation surface

The new renderer safely supports headings, paragraphs, bold, italics, strikethrough, inline code, fenced code blocks, ordered and unordered lists, blockquotes, horizontal dividers, Markdown tables, explicit Markdown links, and bare `https://` links. Comparison tables use a scrollable container on small screens. Links are styled as compact source pills with an external-website icon and accept only `https`, `http`, or `mailto` protocols.

The renderer never interprets model-supplied HTML. It escapes the model text first, creates only the approved markup structures itself, and then passes the final markup through the existing sanitization boundary. Dangerous link schemes such as `javascript:` remain inert text.

## Visual system

| Component | Treatment |
|---|---|
| Headings | Calm hierarchy, restrained scale, tight spacing |
| Key emphasis | Limited bold weight and gentle italic support |
| Lists | Generous line height and distinctive but subtle markers |
| Tables | Responsive horizontal scroll, readable headers, dark-mode support |
| Callouts | Soft gradient surface with a narrow accent rail for key takeaways only |
| Source links | Compact rounded pill with inline external-link icon and visible label |
| Code | Existing high-contrast code surface preserved |

The styles support light mode, dark mode, mobile width, keyboard focus, and reduced-motion preferences.

## Prompt control

The retired instruction that demanded `Thought` and `Response` blocks has been removed. The new prompt contract tells MindPal to select the simplest useful Markdown shape and strictly prohibits visible analysis or internal-process labels. It explicitly limits source links to sources that were actually supplied by a tool.

## Validation

| Check | Result |
|---|---:|
| Prompt-quality regression tests | 23 passed |
| Frontend state and rich-Markdown tests | 8 passed |
| Production frontend build | Passed |
| Prebuilt-asset verification | Passed |
| Patch integrity check | Passed |

## Manual acceptance examples

A response comparing two next steps should render a compact table with two or three columns. A response to a user who is overwhelmed should generally use a short paragraph and perhaps three numbered actions—not a table. A tool-backed source should render as a labeled source pill; an unverified URL must never be fabricated by the model or converted from a dangerous protocol.
