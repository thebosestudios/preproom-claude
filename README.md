# Prep Room for Claude Code

Practice technical interviews where you already work. Prep Room puts a question from its bank (AI-assisted engineering, system design and coding) into your project as files. You write the answer in your own editor, run the examples on your own machine, and take the answer to [preproom.ai](https://preproom.ai) for the hidden checks when you trust it.

It is free and needs no account.

## Install

```
/plugin marketplace add thebosestudios/preproom-claude
/plugin install preproom@preproom
```

You need Node.js 20 or later on your PATH. The plugin has nothing else to install.

## Try it

Ask Claude in your own words, or use a command:

| Say | Or run | What happens |
|---|---|---|
| "Give me a medium coding question in Python" | `/preproom:practice` | Claude offers a few questions and sets up the one you pick |
| "Run a mock interview, 30 minutes" | `/preproom:mock` | Claude plays the interviewer, keeps time and debriefs you at the end |
| "Let's do an AI-assisted round" | `/preproom:round` | Claude is your assistant; you lead, check its work and decide when to submit |
| "Explain union-find" | `/preproom:guide` | Claude walks you through a Prep Room concept guide, a section at a time |

## How it works

A question lands in `prep/<id>/` in your project:

- `README.md` has the task and the examples.
- Your answer goes in one file: `solution.py`, `solution.go`, `query.sql`, `review.py` or `answer.md`, depending on the question.

**Run** tries the examples on this computer with its own toolchain. **Submit** gives you a link that opens the question on preproom.ai with your answer already in the editor. The hidden checks run there, and a free account keeps your progress.

Beside the conversation, the Prep Room pane shows the task, your hints and your last run. A band above the prompt shows the mode and the time left, with Run and Submit. Type `/prep` to bring the pane back. The pane and band work in the terminal, in the Claude Code panel in VS Code and in the Desktop app's Code tab.

### Modes

| Mode | Claude |
|---|---|
| Solo | stays out of your answer file and gives hints one at a time. Say "hand it back" when you want help. |
| Mock interview | plays the interviewer: answers questions about the task, keeps time, asks follow-ups, debriefs. |
| Assisted round | is your assistant and writes what you ask for. At the end it reads the round back: how you directed it, how you checked its work, and what you accepted or turned down. |
| Open | helps however you like. |

### Languages that run on your machine

Python, JavaScript, TypeScript (Node 22.6 or later), C, C++, Go, Rust, Ruby, Perl and Bash, whenever their toolchain is installed. SQL runs on the SQLite that comes with Python. Every other language a question offers runs on preproom.ai, and the plugin gives you the link with your code in it.

## Privacy

- The plugin downloads public question files from preproom.ai and keeps them in `~/.cache/preproom`. That is all it sends: what you searched for never leaves your machine.
- Your code runs on your computer. It goes to preproom.ai only when you open a Submit link, and then inside the link itself, straight into your browser's editor.
- A mock interview or an assisted round keeps its log in `prep/<id>/.round/log.jsonl`, in your project, for the read-back. Delete it whenever you like.
- There is no account inside Claude, and Prep Room has no way to see your conversation.

The full policy: https://preproom.ai/legal/privacy

## Prep Room in Claude chat

Claude on the web, in the Desktop app and on your phone can use Prep Room too, as a connector: questions as cards, hints, model answers and guides, and the same link to take your work to the site. Add it in Claude's settings under Connectors, with this address:

```
https://preproom.ai/api/claude/mcp
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PREPROOM_URL` | `https://preproom.ai` | Point the plugin at another copy of the site, such as a local one |
| `PREPROOM_CACHE` | `~/.cache/preproom` | Where downloaded questions are kept |

## Working on the plugin

- `server/` is the plugin's MCP server: plain Node, no dependencies.
- `server/engine.mjs` is generated from Prep Room's language engine. Rebuild it with `node scripts/build-engine.mjs /path/to/preproom` after the site's `lib/run` changes.
- `hooks/register.tsx` is the pane, the band, the status line and the solo guard.
- `npm test` runs the server's tests.
