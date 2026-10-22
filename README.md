# Claude Status Panel

A side panel for [Claude Code](https://claude.com/claude-code) that shows what the agent is doing while it works, plus an optional Catppuccin Mocha theme.

| Plugin | What it adds |
| --- | --- |
| `status-panel` | The **Status** side panel (`/status-panel`) |
| `catppuccin-mocha` | A Catppuccin Mocha colour theme (pick it in `/theme`) |
| `progress-band` | A loading bar above the prompt with the task list's progress and one line per subagent |

## What the panel shows

- **Mascot** of your choice that dances while Claude is working: click **🖼 Change mascot** and pick any GIF (it plays on desktop and becomes coloured block art in the terminal). None is bundled, so the slot stays blank until you pick one; **✕ Remove** clears it.
- **Working directory**, clickable to open it in Finder.
- Four tabs:
  - **Summary** – a short running summary of the session, rewritten after each prompt (↻ Refresh to redo it now).
  - **Statistics** – files read and written, tool calls (click a tile to list each file or tool and how many times), lines added/removed, failures, tool time, top tools, prompts, tokens, session age.
  - **Activity** – every tool call grouped by prompt (newest first): file reads with line numbers, edits as coloured diffs, command and tool output pretty-printed. Search box, **Load more** for earlier prompts, and each prompt heading scrolls the chat back to where it was sent.
  - **Fornix** – one card per [fornix](https://github.com/ZGA2519/fornix) project-memory MCP server in the working directory's `.mcp.json` (`fornix`, or `fornix-<repo>` per repo in a folder over several), plus any whose tools the session calls: connected or not, memories per scope, top tags, the newest memories, and how many memories this session recalled and wrote (↻ Refresh to re-read). **Off / Read-only / Full** switch that server's sync by writing or removing its `.sync-on` flag (Off skips `/context-stop-sync`'s final flush, and says so), and each card has a search box over that server's memories.

## Progress band

A band just above the prompt box that shows how far through its task list Claude is:

- **Main bar** – step *n* of *total*, the current step and a percentage. On desktop, one rounded segment per step on a coral gradient, the active one pulsing; in the terminal, a thin gradient line. Green with ✓ when every step is done. Fed by the desktop app's task list, `TodoWrite`, the `TaskCreate`/`TaskUpdate` tools, or the band's own plan tool (below).
- **Activity bar** – while a turn runs with no plan: *Working*, the tool calls so far, the latest tool and the elapsed time, over a sweeping glint.
- **One line per subagent** – its type and task, its own to-do progress if it keeps one, how many tools it has called and the latest one, and a small bar (a sweeping glint when it has no list). Turns to ✓ when the subagent finishes.
- **When it shows** – while a turn runs, and afterwards while a background subagent is still working. A finished list and finished subagents are cleared when the turn ends.

### In the terminal CLI

Some CLI setups give Claude no task-list tool, so nothing would feed the bar. In interactive terminal sessions the band registers its own, `mcp__progress-band__plan`, and the first tool result of a turn with no plan carries a one-line reminder to use it. A plugin can't add instructions to Claude's system prompt (Claude Code skips a user-installed plugin's prompt hooks), so Claude may still skip the plan for short tasks; the activity bar shows then. For a plan on every multi-step task, add this line to your `~/.claude/CLAUDE.md`:

```
For any request that takes three or more steps, keep a plan with mcp__progress-band__plan: the whole list first, then advance: true as each step finishes.
```

## Install

In Claude Code (terminal), at the prompt:

```
/plugin install status-panel --marketplace ZGA2519/claude-status-panel
/plugin install catppuccin-mocha --marketplace ZGA2519/claude-status-panel
/plugin install progress-band --marketplace ZGA2519/claude-status-panel
```

Answer `y` to add the marketplace and pick a scope (user = every session).

Or from a shell:

```bash
claude plugin install status-panel --marketplace ZGA2519/claude-status-panel
```

Then:

- open the panel with `/status-panel` (it also opens by itself in wide terminals and in the desktop app),
- pick the theme with `/theme` → **Catppuccin Mocha** (terminal CLI).

Update later with `claude plugin update status-panel@claude-status-panel`, then `/reload-plugins` in open sessions.

## Requirements

- A recent Claude Code (built against 2.1.29x). The plugin uses Claude Code's function-hooks API, which is in early access and can change between releases.
- **🖼 Change mascot**: macOS (it opens the macOS file dialog), `python3`, and `ffmpeg` (`brew install ffmpeg`).
- **Open working directory in Finder**: macOS.
- **Summary tab**: one small Haiku request on your own Claude account after each prompt (the previous summary, your latest prompt, one line per tool call, and Claude's reply cut to 4,000 characters). Nothing is sent anywhere else; everything the panel records stays in your local session.

## Mascot

No mascot ships with the plugin. Each person picks their own GIF with **🖼 Change mascot**; it is converted on their machine and saved in their Claude Code store, so it stays across sessions.

To ship a default for everyone, rebuild the plugin's built-in asset from a GIF you have the rights to:

```bash
cd plugins/status-panel
python3 scripts/build-mascot.py path/to/mascot.gif   # rewrites hooks/mascot-assets.ts
```

## Develop

```bash
claude --plugin-dir plugins/status-panel        # run from the folder, reloads on save
claude plugin test plugins/status-panel          # the test suite
claude plugin validate .                         # marketplace + manifests + hooks
```

`tsconfig.json` extends the types Claude Code writes into `.claude-plugin/types/` the first time it loads the plugin from its folder (as above); they are git-ignored.

The GIF converter lives in `scripts/build-mascot.py`; the panel runs a copy of it from `hooks/build-mascot-script.ts`. After editing the script, refresh that copy with `python3 scripts/build-mascot.py --emit-ts`.
