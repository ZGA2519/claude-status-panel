# Claude Status Panel

A side panel for [Claude Code](https://claude.com/claude-code) that shows what the agent is doing while it works, plus an optional Catppuccin Mocha theme.

| Plugin | What it adds |
| --- | --- |
| `status-panel` | The **Status** side panel (`/status-panel`) |
| `catppuccin-mocha` | A Catppuccin Mocha colour theme (pick it in `/theme`) |

## What the panel shows

- **Mascot** of your choice that dances while Claude is working: click **🖼 Change mascot** and pick any GIF (it plays on desktop and becomes coloured block art in the terminal). None is bundled, so the slot stays blank until you pick one; **✕ Remove** clears it.
- **Working directory**, clickable to open it in Finder.
- Four tabs:
  - **Summary** – a short running summary of the session, rewritten after each prompt (↻ Refresh to redo it now).
  - **Statistics** – files read and written, tool calls, lines added/removed, failures, tool time, top tools, prompts, tokens, session age.
  - **Activity** – every tool call grouped by prompt (newest first): file reads with line numbers, edits as coloured diffs, command and tool output pretty-printed. Search box, **Load more** for earlier prompts, and each prompt heading scrolls the chat back to where it was sent.
  - **Agents** – one card per subagent: type, task, live steps, prompt and final result; stays *running* until the agent really finishes, background agents included.

## Install

In Claude Code (terminal), at the prompt:

```
/plugin install status-panel --marketplace ZGA2519/claude-status-panel
/plugin install catppuccin-mocha --marketplace ZGA2519/claude-status-panel
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
