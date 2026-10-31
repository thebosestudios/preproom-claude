---
name: guide
description: Use when someone wants to learn or review an idea that comes up in technical interviews, such as "explain union-find", "teach me consistent hashing", "how does a rate limiter work", or when a Prep Room question has a concept guide. Reads a Prep Room concept guide a section at a time and offers a question to practice it.
allowed-tools: ["mcp__plugin_preproom_prep-room__*"]
---

# Learn a concept

1. Call `find_guides` with what they asked about, or with the question id when it comes from a question. If several fit, name them in one line each and let them choose.
2. Call `read_guide` for the first section. Explain it in your own words, short, and check they follow before the next section.
3. Go section by section. Use the guide's own examples. The guide's link has its pictures.
4. At the end, offer one of the questions the guide teaches, from `find_questions` or the guide's own list, and set it up with `start_question` if they want it.

Teach the idea, not the answer to a question they are working on in solo mode.
