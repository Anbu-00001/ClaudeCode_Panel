# ccpanel — Build Specification

**Get a working Claude Code system in one keypress.**
Version 2.1 · 2026-08-06 · This is the only file you need to hand to Claude Code.

---

## 0. Start here

### 0.1 The kickoff prompt

Put this file in an empty directory, open Claude Code there, and paste this:

> Read `CCPANEL-SPEC.md` in full before writing anything.
>
> It is the complete build spec for a terminal app. Section 5 contains verified facts about
> Claude Code's own config system, gathered from official docs — **where section 5 and your
> training data disagree, section 5 wins.** Do not substitute remembered file paths or
> setting names.
>
> Build Milestone 1 only (section 13). Stop when it is done and show me. Do not start
> Milestone 2.
>
> Before you write code, tell me: what Milestone 1 includes, what you are unsure about, and
> anything in the spec you think is wrong.

Then, for each subsequent milestone, start a fresh session (`/clear`) and say:
*"Read `CCPANEL-SPEC.md`. Milestones 1–N are done. Build Milestone N+1 only."*

**Do not ask for the whole thing in one go.** It is roughly 4,000 lines of TypeScript plus a
hand-written content library; a single session will lose the spec's constraints somewhere
around the third screen and start inventing.

### 0.2 Rules for the build

Read sections 1–5 before writing any code. Where the spec is silent, check
`https://code.claude.com/docs/en/settings`, `/skills`, `/hooks` and `/commands` before
guessing.

Build in the order in §13. Milestone 1 must work and be manually used before Milestone 2
starts. **Milestone 3 builds kit #11 (the deletion warning) first, on purpose** — see §13 for
why.

**If you read only one thing:** this is not a config manager. It is an onboarding ramp. The
hard part is the writing in §11, not the code.

---

## 1. The problem, with evidence

### 1.1 What the data says

A June 2026 study classified 2,500 public GitHub repositories that use Claude Code. The
adoption ladder:

| Feature | Adoption |
|---|---|
| `CLAUDE.md` (plain instructions) | 84.9% |
| `.claude/` directory of any kind | 62.1% |
| Any power feature at all | 53.9% |
| `.claude/settings.json` | 41.0% |
| Skills | 28.1% |
| Custom slash commands | 25.6% |
| Custom subagents | 24.6% |
| Project `.mcp.json` | 17.0% |
| Hooks | 13.3% |

Each rung up loses roughly a third of the field. The study's own conclusion: the ecosystem
is **wide and shallow** — lots of people have it installed and pointed at their repo, a
minority have built a system on top of it.

Two caveats, stated up front: the study's author sells a paid Claude Code starter kit, so it
is motivated to make the gap look large; and it only sees public repos, so real adoption of
deep features is probably somewhat higher. Directionally it matches everything else — the
gap is real.

### 1.2 What that means for this product

**It kills the obvious product and creates a better one.**

Only 17% have an `.mcp.json`. Only 28% have skills. So a dashboard that toggles your MCP
servers and skills on and off is a tool for a minority who already went deep — and they are
exactly the people who don't need plain English, because they already know what MCP stands
for. For three of four users, a management dashboard opens to empty lists. **You cannot
organize an empty room.**

The gap is not *"I have twelve tools and can't manage them."*
The gap is *"I didn't know subagents existed, and wiring one from scratch looked like work."*

So: **ccpanel is a discovery and setup tool.** It tells you what Claude Code can do that you
aren't using, explains it in one paragraph a beginner understands, and then sets it up for
you when you press Enter. Toggles still exist, but they are a secondary screen that becomes
useful *after* the user owns more than a couple of things.

### 1.3 What already exists (do not rebuild these)

Claude Code natively has `/mcp`, `/skills`, `/plugin`, `/config`, `/usage`, `/context` and
`/doctor` — arrow-key menus for most management tasks. `skillOverrides` and
`disabledMcpjsonServers` are documented, native switches; **we invent no mechanism.**

Seven third-party tools manage Claude Code config (`cc-config`, `claude-dash`,
`Claude-Code-MCP-Server-Selector`, and others). All of them manage. **None of them
discover.** `/doctor` finds *unused* things you already installed; nothing tells you a
feature exists in the first place. That empty space is the entire product.

Build fresh, MIT. `cc-config` is the only prior art covering similar ground and it ships no
LICENSE file, so it is not forkable.

---

## 2. The user

One person. Every UI decision resolves against them.

> Six weeks into programming, or a working developer who installed Claude Code last month.
> Has a `CLAUDE.md` because a tutorial said to. Has never made a skill. Has heard "MCP" and
> couldn't define it. Suspects they're using 20% of the tool. Would be put off by the word
> "scope", and would not read a docs page to find out what a subagent is.

**Design rule:** if a screen shows a word this person would have to look up, the screen is
wrong. Not a tooltip — the word does not appear.

**Success feels like:** clone or `npx`, one command, arrow down twice, press Enter, and now
Claude reviews their code automatically. They never learned a term. It just works.

---

## 3. The core idea

Two mechanics, and nothing else.

### 3.1 The Ladder

On launch, read the folder and work out which rungs the user is on. Show them where they
are and what's next. Never scold. Never gamify with points or streaks.

```
   You're using 3 of 9 things Claude Code can do.

   ✓ Project instructions        ✓ Permissions      ✓ Commands
   · Skills          · Helpers          · Tools
   · Automatic checks    · Memory        · Parallel work
```

### 3.2 Kits

A **Kit** is a small, pre-written bundle that sets up one useful capability end to end:
files, config, and a thing to try, installed together by pressing Enter.

This is the "bamm" — the user doesn't assemble a system, they pick a goal and get one.

```
   Set up in one step

   →  Claude reviews your code before you commit
      Adds a reviewer that catches bugs in your changes.        [ 3 files ]

      Claude tests your site in a real browser
      Lets Claude click through your app to check it works.     [ 1 tool ]

      Claude remembers how you like things done
      Turns your habits into instructions it follows.           [ 2 files ]
```

Nothing is described by what it *is* (a subagent, an MCP server). Everything is described by
what it *does for you*. The mechanism appears only if the user presses Enter to see details.

### 3.3 The loop

```
        ┌──────────────────────────────────────────┐
        │  See where you are      (the Ladder)     │
        │            ↓                             │
        │  Pick something you don't have  (Kits)   │
        │            ↓                             │
        │  See exactly what will happen (Preview)  │
        │            ↓                             │
        │  Enter → it's set up                     │
        │            ↓                             │
        │  "Try this now: /review"                 │
        └──────────────────────────────────────────┘
```

Every kit install ends with **one concrete thing to type**. A setup the user never exercises
is a failed install.

---

## 4. Non-negotiable constraints

Violating any of these is a failed build.

**C1 — The app never spends the user's money.** Zero calls to any Anthropic API. No model
calls, no telemetry, no AI-generated recommendations. Every number is arithmetic over local
files. Permitted network calls: the MCP registry search API (§10.4) and `npx`/`npm` during an
install the user explicitly started.

**C2 — The app never runs a Claude Code prompt itself.** When a kit says "try this now", the
app copies the command or exits and `exec`s `claude` with it pre-filled. It never runs
`claude -p` in the background. The user always watches their own money being spent.

**C3 — The app never corrupts a config file.** Claude Code parses user, project and local
settings **strictly** — a file that fails validation is rejected *in its entirety*. One stray
comma in `settings.json` silently kills every permission rule and hook the user had. Follow
§12.1 exactly, every time.

**C4 — Everything is reversible.** Every kit has a clean uninstall that removes exactly what
it added and nothing else. Every toggle flips back with one keypress.

**C5 — Nothing installs without a preview.** The user sees every file that will be created
and every config key that will change, before anything happens. No silent writes.

**C6 — Secrets are masked by default** (§12.4).

**C7 — Linux only in v1.** No `pbcopy`, no `open`, no `%USERPROFILE%`.

---

## 5. Ground truth: how Claude Code actually stores this

**Verified against official docs, 2026-08-06.** Read completely — this is why the app can be
built safely.

### 5.1 Where things live

| What | User scope | Project scope | Local scope |
|---|---|---|---|
| Settings | `~/.claude/settings.json` | `<repo>/.claude/settings.json` | `<repo>/.claude/settings.local.json` |
| MCP servers | `~/.claude.json` | `<repo>/.mcp.json` | `~/.claude.json` (per project path) |
| Skills | `~/.claude/skills/<name>/SKILL.md` | `<repo>/.claude/skills/<name>/SKILL.md` | — |
| Subagents | `~/.claude/agents/*.md` | `<repo>/.claude/agents/*.md` | — |
| Commands (legacy) | `~/.claude/commands/*.md` | `<repo>/.claude/commands/*.md` | — |
| Plugins | `enabledPlugins` in settings.json | same | same |
| Instructions | `~/.claude/CLAUDE.md` | `CLAUDE.md` or `.claude/CLAUDE.md` | `CLAUDE.local.md` |

Precedence, highest first: **Managed → CLI args → Local → Project → User.** Permission rules
*merge* across scopes instead of overriding.

`.claude/settings.local.json` resolves to the **git repository root** (through worktrees),
not the directory you launched from. Outside a git repo, or when the repo root is the home
directory, it stays in the current directory. Get this wrong and you write into a file
Claude Code never reads.

`~/.claude.json` holds the OAuth session, per-project trust state and caches. **v1 reads it
but never writes it.** To add a user-scope MCP server, shell out to `claude mcp add -s user`
instead.

### 5.2 Skills

A skill is a directory containing `SKILL.md`: YAML frontmatter plus markdown. The directory
name becomes the command. Only `description` is really needed. Fields we use in kits:

- `description` — what it does and when to use it. Claude matches on this.
- `disable-model-invocation: true` — only the user can trigger it. Use for anything with
  side effects (deploy, commit, send).
- `user-invocable: false` — only Claude can trigger it. Use for background knowledge.
- `allowed-tools` — pre-approved tools for the turn that invokes it, so it doesn't prompt.
- `context: fork` — runs in its own subagent context; `agent:` picks which type.
- `argument-hint`, `arguments`, `paths`, `model`, `effort`, `hooks`, `disallowed-tools`.

Body substitutions: `$ARGUMENTS`, `$0`/`$1`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`,
`${CLAUDE_SESSION_ID}`. Inline `` !`command` `` runs a shell command and injects its output
*before* Claude sees the file — this is how a kit ships a skill that always has live `git
diff` in it.

Custom commands merged into skills: `.claude/commands/deploy.md` and
`.claude/skills/deploy/SKILL.md` both produce `/deploy`.

### 5.3 The four native toggles — we invent nothing

| Thing | Mechanism | Written to |
|---|---|---|
| MCP server from `.mcp.json` | `disabledMcpjsonServers: ["name"]` | any settings.json scope |
| Skill | `skillOverrides: {"name": "off"}` | `.claude/settings.local.json` |
| Plugin | `enabledPlugins` | settings.json |
| All claude.ai connectors | `disableClaudeAiConnectors: true` | any scope (all-or-nothing) |
| Bundled skills | `disableBundledSkills: true`, or per-skill `skillOverrides` | any scope |

`skillOverrides` is **four-state**, not boolean:

| Value | Claude sees | In `/` menu |
|---|---|---|
| `"on"` (or absent) | name + description | yes |
| `"name-only"` | name only | yes |
| `"user-invocable-only"` | hidden | yes |
| `"off"` | hidden | hidden |

`"name-only"` is genuinely useful — keeps the skill working while reclaiming the context its
description ate. Don't collapse these into a boolean. Plugin skills are **not** affected by
`skillOverrides`.

### 5.4 Hooks

Shell commands Claude Code runs at fixed lifecycle events, reading a JSON event on stdin and
replying via exit code or JSON on stdout. Configured under `hooks` in any `settings.json`
scope. Roughly 30 events exist; we use one.

**`PreToolUse` is the only event that can stop a tool call before it runs.** Two reply
channels:

- **Exit code.** `0` allows. `2` blocks, and stderr is fed back to Claude as the reason. Any
  other non-zero is a non-blocking error, logged and ignored.
- **JSON on stdout.** `hookSpecificOutput.permissionDecision` of `allow`, `deny`, `ask` or
  `defer`, with `permissionDecisionReason`. Also supports `updatedInput` (rewrite the tool
  arguments) and `additionalContext`.

`ask` escalates to the user — that is the one we want for warnings (§9.5).

Two properties that matter:

- **Hooks run even under `--dangerously-skip-permissions`.** That flag skips interactive
  prompts, not hooks.
- **`disableAllHooks: true` in any scope turns them all off**, along with any custom status
  line. Detect this before installing a hook-based kit.

`${CLAUDE_PROJECT_DIR}` resolves in hook commands, so reference scripts by that rather than a
relative path.

### 5.5 What has no clean per-item switch

Be honest in the UI: **user-scope MCP servers** (in `~/.claude.json`) and **individual
claude.ai connectors** cannot be toggled one at a time by a normal user.
`disabledMcpjsonServers` targets `.mcp.json` only; `deniedMcpServers` is managed-settings-only.
Display them, mark them, offer the safe path. Never fake a switch you can't honour.

### 5.6 Live reload — the app's best moment

Claude Code watches settings files and reloads on change, so most edits apply to a **running
session without a restart**. Skill directories are watched too — adding or editing a skill
is picked up mid-session, and `/reload-skills` forces a rescan.

**So a kit installed in ccpanel lights up in an already-open Claude Code session.** Build the
UI around this; it is the single most impressive thing the app does.

Exceptions needing a restart or explicit command: `model`, `outputStyle`, and plugin
component changes (`/reload-plugins`). Say so plainly when relevant.

### 5.7 Existing safety nets

Claude Code auto-creates timestamped backups of config files and keeps the five most recent.
Useful but not sufficient — five rotations vanish fast, so we keep our own (§12.3).

### 5.8 Spend data limits

`ccusage` is MIT, reads local JSONL transcripts, offers `--json`, `--breakdown` (per
**model**), `--instances`/`--project` (per **project**), and `daily`/`weekly`/`monthly`/
`session`/`blocks`. **It cannot attribute cost to an individual MCP server or skill.** No
tool can, from transcripts alone. Do not imply otherwise (§10.7).

---

## 6. Scope

### 6.1 In scope for v1

1. **Ladder** — where you are, what's next.
2. **Kits** — one-keypress setup of ~10 curated capabilities.
3. **Preview & Undo** — see exactly what changes; remove it cleanly.
4. **Explore** — plain-English explanation of every Claude Code capability.
5. **Commands** — searchable library of every official command.
6. **Manage** — toggles for what you now own (secondary screen).
7. **Spending** — ccusage wrapped, jargon stripped.
8. **Repair** — validate config files, restore from backup.

### 6.2 Explicitly out of scope

Do not build. If you finish early, improve the writing in §11.

Web dashboard · profiles/snapshots · session browser · hooks editor · permission-rule editor
· multi-editor sync · writing `~/.claude.json` · AI-generated recommendations · macOS/Windows
· telemetry of any kind · gamification (points, streaks, badges).

---

## 7. Stack

- **Runtime:** Node 18+. Claude Code already requires Node, so it's guaranteed present.
- **TUI:** [Ink](https://github.com/vadimdemedes/ink) (React for terminals).
- **Language:** TypeScript, strict.
- **Distribution:** `npx ccpanel` primary; `npm i -g ccpanel` secondary. Clone-and-run must
  also work: `git clone && npm i && npm start`.
- **Cold start budget: under 1.5s to first paint.**
- **License:** MIT, from day one.
- **Deps:** keep under ten — `ink`, `react`, `zod`, `yaml`, `clipboardy`. No state library.

### 7.1 Layout

```
ccpanel/
├── src/
│   ├── cli.tsx                 # entry, terminal size guard
│   ├── app.tsx                 # screen router
│   ├── screens/
│   │   ├── Ladder.tsx          # home
│   │   ├── Kits.tsx
│   │   ├── KitDetail.tsx       # preview + install
│   │   ├── Explore.tsx
│   │   ├── Commands.tsx
│   │   ├── Manage.tsx
│   │   ├── Spending.tsx
│   │   ├── Undo.tsx
│   │   └── Repair.tsx
│   ├── components/
│   │   ├── List.tsx            # the ONE list component
│   │   ├── Toggle.tsx
│   │   ├── SearchBar.tsx
│   │   ├── Preview.tsx         # file/config diff view
│   │   ├── Footer.tsx          # live key hints
│   │   └── Confirm.tsx
│   ├── core/
│   │   ├── paths.ts            # repo-root resolution
│   │   ├── detect.ts           # which rungs is the user on
│   │   ├── kits.ts             # load, preview, install, uninstall
│   │   ├── write.ts            # THE ONLY MODULE THAT WRITES (§12.1)
│   │   ├── undo.ts
│   │   ├── validate.ts         # zod schemas
│   │   ├── ccusage.ts
│   │   ├── registry.ts
│   │   └── mask.ts
│   └── data/
│       ├── commands.json       # §11.2
│       ├── explain.json        # §11.1
│       └── plain-names.json    # §16
├── kits/                       # §9 — one directory per kit, plain files
├── test/
└── LICENSE
```

**`core/write.ts` is the only file permitted to call `fs.writeFile`.** Enforce with a lint
rule.

---

## 8. Interaction

### 8.1 Keys — the whole vocabulary

| Key | Does |
|---|---|
| `↑` `↓` | move |
| `←` `→` | switch section |
| `Enter` | do the thing under the cursor |
| `Space` | flip a switch (Manage screen only) |
| `/` | search this list |
| `u` | undo last change |
| `?` | help |
| `Esc` | back |
| `q` | quit |

Arrows and Enter must reach every feature. Letters are shortcuts only.
**No vim keys** (`j`/`k`/`g`/`G`) — our user doesn't know them and they clutter the footer.

Footer shows only keys valid *right now*. Never a static list.

### 8.2 Tone

- Second person, present tense. "You're using 3 of 9 things."
- Never name a config key, file path or JSON field in normal flow. Those live in Preview and
  Repair only.
- State the consequence, not the mechanism. Not *"Adds a subagent"* but *"Claude will check
  your changes for bugs before you commit."*
- Errors: what happened, what it means, what to do. Three sentences max.
- Never shame. "You're using 3 of 9" is a map, not a report card. Avoid "only", "just",
  "you should".

### 8.3 Sizing

Minimum 80×24. Below that print one line — *"ccpanel needs a window at least 80 columns
wide."* — and exit 0. Handle `SIGWINCH`.

---

## 9. Kits — the heart of the product

### 9.1 What a kit is on disk

A directory under `kits/`, containing a manifest and the literal files it installs. Plain,
readable, reviewable, and PR-able by strangers — that last property is the growth mechanism.

```
kits/code-reviewer/
├── kit.json
├── agents/
│   └── reviewer.md
└── skills/
    └── check/
        └── SKILL.md
```

### 9.2 Manifest schema

```json
{
  "id": "code-reviewer",
  "title": "Claude reviews your code before you commit",
  "blurb": "Adds a reviewer that reads your changes and points out bugs, missing error handling, and anything you left behind by accident.",
  "rung": "helpers",
  "requires": { "minClaudeVersion": "2.1.145", "git": true },
  "installs": [
    { "kind": "subagent", "name": "reviewer", "from": "agents/reviewer.md",
      "to": ".claude/agents/reviewer.md" },
    { "kind": "skill", "name": "check", "from": "skills/check/SKILL.md",
      "to": ".claude/skills/check/SKILL.md" },
    { "kind": "settings", "scope": "local",
      "patch": { "permissions": { "allow": ["Bash(git diff *)", "Bash(git status *)"] } } }
  ],
  "tryThis": "/check",
  "tryThisExplain": "Make a small edit to any file, then type this in Claude Code.",
  "explain": "A helper is a second Claude that works on one job in its own conversation…",
  "uninstallNote": null
}
```

`kind` is one of: `skill`, `subagent`, `command`, `mcp`, `settings`, `claudemd`, `plugin`.

- `mcp` entries carry `command`, `args`, optional `env` with `promptFor` fields, and a
  `scope` of `project` (writes `.mcp.json`) or `user` (shells out to `claude mcp add -s user`).
- `plugin` entries shell out to `claude plugin install <name>@<marketplace>` and must state
  that a restart or `/reload-plugins` may be needed.
- `claudemd` entries **append a clearly fenced block** to `CLAUDE.md`, never overwrite:

  ```
  <!-- ccpanel:code-reviewer -->
  …content…
  <!-- /ccpanel:code-reviewer -->
  ```

  Uninstall removes exactly that fenced block. If a user edited inside the fence, keep their
  edit and tell them.

### 9.3 Install flow

```
┌─ Claude reviews your code before you commit ─────────────┐
│                                                          │
│  Adds a reviewer that reads your changes and points out  │
│  bugs, missing error handling, and anything you left     │
│  behind by accident.                                     │
│                                                          │
│  This will:                                              │
│   + create   .claude/agents/reviewer.md                  │
│   + create   .claude/skills/check/SKILL.md               │
│   ~ change   .claude/settings.local.json                 │
│              lets Claude run "git diff" without asking   │
│                                                          │
│  Nothing else on your computer is touched.               │
│                                                          │
│         [ Set it up ]      [ Show me the files ]         │
│                                                          │
└─ ↑↓ move · Enter choose · Esc back ──────────────────────┘
```

Then, on success:

```
   Done. Claude will review your changes now.

   Try this: /check
   Make a small edit to any file, then type that in Claude Code.

   [ Copy /check ]   [ Open Claude Code ]   [ Undo this ]
```

**Rules:**
- Preview is mandatory (C5). "Show me the files" displays full contents, scrollable.
- If a target file already exists with different content, **stop and ask** — offer skip,
  overwrite (with backup), or install under a suffixed name.
- If the kit needs a credential, prompt one field at a time with a plain label ("Your
  database connection string"), masked as typed, never echoed back.
- Verify after install: for `mcp`, confirm the server starts; for files, confirm they parse.
  On failure, show the real error and offer a full rollback.
- Detect already-installed kits and show them as `✓ already set up` with an uninstall option.

### 9.4 The ten v1 kits

Ordered by the ladder. Each maps to a rung the data says most people never reach.

| # | Kit | Rung | What it installs |
|---|---|---|---|
| 1 | Claude knows your project | instructions | Guided `CLAUDE.md` starter (not `/init` — this one asks 4 plain questions) |
| 2 | Claude stops asking permission for safe things | permissions | `settings.json` allow-rules for read-only commands |
| 3 | Claude reviews your code before you commit | helpers | subagent + skill |
| 4 | Claude writes your commit messages | commands | skill with `disable-model-invocation`, live `git diff` injection |
| 5 | Claude remembers how you like things done | instructions | skill capturing conventions + `CLAUDE.md` block |
| 6 | Claude tests your site in a real browser | tools | Playwright MCP (project scope) |
| 7 | Claude reads your database | tools | Postgres/SQLite MCP, prompts for connection string |
| 8 | Claude explores before it edits | helpers | `Explore`-agent skill with `context: fork` |
| 9 | Claude checks its own work | automatic checks | a hook that runs your test command after edits |
| 10 | Claude keeps big jobs from eating your memory | memory | `name-only` skill overrides + an autocompact setting |
| 11 | **Claude warns you before deleting anything big** | automatic checks | `PreToolUse` hook + settings patch — see §9.6 |

Each ships with real, tested file contents. **Do not ship a kit you have not run yourself.**

Kit #11 is the flagship. It is the most immediately valuable thing in the list for a
beginner, the easiest to demo, and the most shareable. Build it first among the kits.

### 9.5 Kit #11 — the deletion warning

**The correction that shapes this feature:** ccpanel is not running while Claude Code is.
There is no ccpanel process to paint an alert bar during a session. So this cannot be a
ccpanel screen — it must be a **hook that Claude Code fires**, which ccpanel installs.

We control the *warning text*. Claude Code renders the *prompt*. Don't promise a custom UI.

#### What the user sees

When Claude is about to run something destructive, Claude Code stops and shows the
confirmation prompt with our text in it:

```
   Claude wants to run:
     rm -rf build/ dist/ node_modules/

   ⚠  This deletes 3 folders and can't be undone.
      Nothing here is saved in git.

   Allow?  (y / n)
```

#### How it works

A `PreToolUse` hook, matched to `Bash`, `Edit` and `Write`. It reads the tool call as JSON on
stdin, decides, and replies on stdout:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "This deletes 3 folders and can't be undone. Nothing here is saved in git."
} }
```

`permissionDecision` accepts `allow`, `deny`, `ask` and `defer`. **Use `ask`, not `deny`.**
We are warning, not policing — the user stays in charge, and `deny` would make Claude stop
and go idle rather than let the user decide.

Verified facts that make this worth building:

- `PreToolUse` is the **only** hook event that can stop a tool call before it runs.
- Hooks fire **regardless of `--dangerously-skip-permissions`** — that flag skips interactive
  prompts, not hooks. So this protects exactly the users who turned off the safety rails.
- A bash script doing a handful of `grep`/`jq` calls runs in well under 50ms, negligible
  against model latency.
- Exit code 2 also blocks, feeding stderr back to Claude as the reason. Keep this as the
  fallback path (see the known bug below).

#### What counts as "major"

The single biggest design risk here is **alert fatigue**. Warn too often and the user
reflexively presses `y`, which is worse than no warning at all. Keep the list tight and
tuned for *irreversible and wide*, not merely *destructive*.

Warn on:

| Pattern | Why |
|---|---|
| `rm -rf` / `rm -r` on a directory | The classic |
| Any `rm` touching `/`, `~`, `..`, or a bare `*` | Blast radius |
| `git reset --hard`, `git clean -fd`, `git checkout -- .` | Discards uncommitted work silently |
| `git push --force` / `--force-with-lease` to a shared branch | Rewrites others' history |
| `DROP TABLE`, `DROP DATABASE`, `TRUNCATE` | Irreversible |
| `DELETE FROM` with no `WHERE` | Almost always a mistake |
| `dd if=`, `mkfs`, `> /dev/sd*` | Disk-level |
| `docker system prune -a`, `kubectl delete`, `terraform destroy` | Wide and remote |
| Deleting `.env`, `*.pem`, `*.key`, credentials | Unrecoverable secrets |
| A single `rm` naming more than 5 paths | Bulk |

Do **not** warn on: deleting inside `node_modules/`, `dist/`, `build/`, `.next/`, `target/`,
`__pycache__/`, or anything already git-ignored; `rm` of a single file the user just created
this session; anything inside `/tmp`.

#### Making the message actually useful

Two enrichments do most of the work, and both are cheap:

1. **Git awareness.** Run `git status --porcelain` and `git check-ignore` on the targets. If
   everything is committed, say *"All of this is saved in git, so you can get it back."* If
   not, say *"3 files here have changes that aren't saved in git."* The second sentence is
   the one that stops a bad approval.
2. **Counting.** Resolve globs and say *"deletes 47 files"*, not *"runs rm -rf src/"*. Numbers
   land where paths don't.

Message rules: two lines maximum, plain English, no jargon, lead with the consequence. Never
print the raw pattern name or a rule ID.

#### Files this kit installs

```
kits/deletion-warning/
├── kit.json
└── hooks/
    └── warn-before-delete.sh
```

The settings patch, written to project scope so a team can share it:

```json
{ "hooks": { "PreToolUse": [ {
    "matcher": "Bash|Edit|Write",
    "hooks": [ { "type": "command",
                 "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/warn-before-delete.sh" } ]
} ] } }
```

Use `${CLAUDE_PROJECT_DIR}` so the path resolves wherever the session starts. `chmod +x` the
script on install and verify it is executable — a non-executable hook fails silently, which
is the worst possible outcome for a safety feature.

#### Non-negotiables for this kit

- **Fail open.** If the script errors, times out, or can't parse its input, it exits 0 and
  allows the call. A safety feature that bricks someone's session gets uninstalled, and then
  they have no safety feature. Wrap everything; never let a bug become a block.
- **Zero network, zero AI.** Pure pattern matching plus `git`. This is C1, and it is also why
  it can run on every tool call without costing anything.
- **Fast.** Hard-cap at 200ms; past that, allow and move on.
- **Honest in the UI.** The install preview must say plainly: *"This catches common
  destructive commands. It won't catch everything — treat it as a seatbelt, not a wall."*
  Overselling a partial safety net is worse than not shipping one.
- **`disableAllHooks` beats us.** If that setting is on anywhere, the hook never runs. Detect
  it and warn during install rather than silently installing something inert.

#### Known bug to test around

GitHub issue [#37210](https://github.com/anthropics/claude-code/issues/37210) reports
`permissionDecision: "deny"` being ignored for the `Edit` tool in some versions, with the edit
executing anyway. A separate issue (#24327) reports exit-code-2 blocks sometimes causing
Claude to go idle instead of adapting.

Therefore: **test this kit against the installed Claude Code version before shipping it**, and
have the installer run a self-check — fire a synthetic destructive `Bash` call through the
hook and confirm the prompt appears. If it doesn't, tell the user the hook installed but
their version may not honour it. Never let someone believe they're protected when they
aren't.

#### Where this appears in ccpanel

- On the **Ladder**, if the kit isn't installed, it ranks first among suggestions.
- On **Manage**, once installed, one row: `Warn before big deletions · On` with `Space` to
  toggle (writes `disableAllHooks`? **no** — toggle by adding/removing our hook entry only;
  never touch the global switch).
- On **Repair**, verify the script still exists and is executable.

### 9.6 Community kits (v1.1, design for it now)

Kit format must be a stable, documented contract from day one so people can PR new kits.
Keep a `CONTRIBUTING.md` with the schema and a checklist. Do **not** build remote kit
fetching in v1 — bundled only, no arbitrary code execution from the internet.

---

## 10. Screens

### 10.1 Ladder (home)

```
┌─ ccpanel ─ my-website ────────────────── $12.40 this month ─┐
│                                                             │
│   You're using 3 of 9 things Claude Code can do.            │
│                                                             │
│   ✓ Project instructions   ✓ Permissions   ✓ Commands       │
│   · Skills   · Helpers   · Tools                            │
│   · Automatic checks   · Memory   · Parallel work           │
│                                                             │
│   Set up in one step                                        │
│    → Claude reviews your code before you commit             │
│      Claude writes your commit messages                     │
│      Claude tests your site in a real browser               │
│                                                             │
│   Explore everything      →                                 │
│   Manage what you have    →                                 │
│   Spending                →                                 │
│                                                             │
└─ ↑↓ move · Enter open · ? help · q quit ────────────────────┘
```

Detection (`core/detect.ts`) reads the filesystem only — never guesses, never phones home.
Suggested kits are the highest-value ones the user doesn't already have. **Order is
hand-curated, not scored** — resist building a recommendation engine.

If nothing is configured at all, lead with kit #1 and a single sentence: *"Start here — it
takes about a minute."*

### 10.2 Kits

Full list, grouped by rung, with `✓ already set up` markers. `Enter` → §9.3.

### 10.3 Explore

The teaching screen. One entry per capability: what it is in plain English, when you'd want
it, one concrete example, and — if a kit provides it — `[ Set it up ]`.

```
   Helpers

   A helper is a second Claude that works on one job in its own
   conversation. It doesn't see your main chat, so it starts clean
   and doesn't clutter what you're working on.

   You'd want one when a job is big enough to get in the way —
   reviewing a diff, searching a large codebase, writing tests.

   Example: a reviewer helper reads your changes and reports back
   just the problems, without filling your conversation with the
   whole file.

   [ Set it up ]   [ Read Anthropic's docs ]
```

Covers: instructions, permissions, commands, skills, helpers (subagents), tools (MCP),
connectors, bundles (plugins), automatic checks (hooks), memory/context, parallel work.

### 10.4 Commands

Searchable library of every official command, grouped: **Starting out · Every day · Saving
money · Checking your work · Running things in parallel · When something's wrong · Settings ·
Account**. Plus **Your own**, read from `.claude/commands/*.md` and user-invocable skills.

`Enter` → confirm with a mandatory token warning:

```
   /compact
   Shrink the conversation to free up room.

   This runs in Claude Code and uses tokens.

   [ Copy it ]   [ Open Claude Code and run it ]
```

### 10.5 Manage

Secondary. Two lists — **Tools** (MCP) and **Abilities** (skills) — with `Space` to toggle.

Tools group as: **This folder** (from `.mcp.json`, fully toggleable), **All folders**
(user scope, **read-only** — `Space` explains and offers to copy `claude mcp remove <name>`),
**From claude.ai** (connectors, one shared switch — say so *before* Space is pressed).

Abilities use the four `skillOverrides` states, renamed:

| State | Label | Row sub-label |
|---|---|---|
| `on` | **On** | Claude can use this, and it's in your `/` menu |
| `name-only` | **Quiet** | Still works, uses less of Claude's memory |
| `user-invocable-only` | **Only when you ask** | Claude won't reach for it on its own |
| `off` | **Off** | Hidden completely |

`Space` cycles; footer shows the next state (`Space → Quiet`). Plugin skills are marked
`↳ part of a bundle · not switchable here` with `Space` disabled.

If both lists are empty, don't show an empty screen — show *"You haven't added any tools or
abilities yet."* and a link to Kits.

### 10.6 Undo

Reverse-chronological list of every change, including whole kit installs as single entries.
`Enter` reverts one. Reverting is itself logged.

### 10.7 Spending

Wraps `npx ccusage@latest <sub> --json`. Cache 60s. If ccusage is missing or fails, say
*"Can't read your usage right now"* with the real error behind `Enter` — never a fake zero.

Map `--instances`/`--project` → **"Where it went"**; `--breakdown` → **"By model"**. Footer:
*"This is worked out from files on your computer. Nothing was sent anywhere."*

**Honest limit — do not violate.** Per-tool and per-skill dollar attribution does not exist
in the data. Don't invent a proxy. If asked, say: *"We can show what each project and model
cost. We can't split it by individual tool — that isn't recorded anywhere on your computer."*
The honest adjacent metric is *context* cost per skill (~100 tokens per description per
session), shown on Manage as "uses a little / some / a lot of Claude's memory" — never as
dollars. Point at `/context` and `/doctor` for the deeper native version.

### 10.8 Repair

Runs on demand and automatically whenever a config file fails to parse. Reports each known
file as OK or broken with the parse error and line number; offers restore from Claude Code's
own timestamped backups or ours. Surfaces `claude doctor` as a copyable command.

---

## 11. The content library — this is the real work

**The code is the easy half.** A kit that installs perfectly but is described in a sentence
the user doesn't understand has failed. Budget real time here, and write it yourself rather
than generating it.

### 11.1 `explain.json`

One entry per capability:

```json
{
  "id": "subagents",
  "plainName": "Helpers",
  "oneLine": "A second Claude that works on one job on its own",
  "whatItIs": "…2–3 sentences, no jargon…",
  "whenYouWantIt": "…the situation the user is in…",
  "example": "…one concrete scenario…",
  "kitId": "code-reviewer",
  "docsUrl": "https://code.claude.com/docs/en/sub-agents"
}
```

Rules: no term used before it's defined; no sentence over 20 words; every entry passes the
read-aloud test — if it sounds like documentation, rewrite it.

### 11.2 `commands.json`

```json
{
  "generated": "2026-08-06",
  "sourceUrl": "https://code.claude.com/docs/en/commands",
  "commands": [
    { "name": "/compact", "args": "[instructions]", "category": "Saving money",
      "plain": "Shrink the conversation to free up room",
      "why": "Use when Claude starts forgetting things you said earlier.",
      "costsTokens": true, "aliases": [], "minVersion": null }
  ]
}
```

`plain` under 60 chars, imperative. `why` names the *situation*, one sentence.

**Sourcing policy: the official commands page only.** Community cheat sheets are **not safe
to ingest** — one widely-shared "complete list" contains `/godmode`, `BEASTMODE`, `/ghost`,
`/punch`, `/mirror`, `/approve` and `/skip`, none of which exist. Shipping those to a
beginner teaches them to type nonsense and conclude the tool is broken. Cheat sheets may be
read as *leads only*; anything found must be verified on the official page before it ships.
(X and LinkedIn are login-walled and weren't scrapable — a known gap, not a silent omission.)

Ship every official command, including ones beginners won't use — put them in low-priority
categories rather than omitting them. Mark bundled skills and workflows so the UI can badge
them.

### 11.3 Staleness

Claude Code ships fast and commands disappear (`/pr-comments` was removed in v2.1.91).
Therefore: Ladder shows a quiet note when `generated` is over 60 days old; ship
`npm run refresh-commands`, a **maintainer** script that fetches the docs page and prints a
diff for a human to review. **It must not auto-write** — `plain` and `why` are hand-written
and a scraper would destroy them. Never call the docs page from a user's machine at runtime.

---

## 12. Safety

### 12.1 The write protocol — mandatory, every write

`core/write.ts` implements exactly this. No screen bypasses it.

1. **Read** the file. Missing → treat as `{}`.
2. **Parse.** On failure: **abort**, change nothing, route to Repair. Never "fix" an
   unparseable file by overwriting it.
3. **Snapshot** raw bytes to `~/.claude/ccpanel/backups/<iso8601>-<basename>`.
4. **Mutate** in memory — only the keys this operation owns.
5. **Validate** against the zod schema (§12.2).
6. **Serialize** with 2-space indent and trailing newline, matching Claude Code's style.
7. **Write atomically:** to `<file>.ccpanel.tmp` in the same directory, `fsync`, then
   `rename()` over the target. Never truncate the original.
8. **Re-read and re-parse.** If it doesn't parse, restore the snapshot immediately and
   report failure.
9. **Append** to the undo log.

A kit install is a **transaction**: if any step fails, roll back everything already applied
in that install, then report.

Never use a JSON5/JSONC parser to accept a comment-laden file and write it back as strict
JSON — that silently destroys the user's comments. Unparseable is a Repair case.

### 12.2 Validation

Zod schemas for `settings.json`, `settings.local.json` and `.mcp.json`, modelling the keys we
touch. **Use `.passthrough()`, never `.strict()`** — the user's file contains keys we've
never heard of, and a stripping schema would silently delete their hooks.

### 12.3 Undo log

Append-only JSONL at `~/.claude/ccpanel/undo.jsonl`:

```json
{"ts":"2026-08-06T14:22:01Z","kind":"kit","id":"code-reviewer",
 "label":"Set up: Claude reviews your code before you commit",
 "changes":[
   {"file":"/home/u/p/.claude/agents/reviewer.md","op":"create"},
   {"file":"/home/u/p/.claude/settings.local.json","op":"patch",
    "key":"permissions.allow","before":[],"after":["Bash(git diff *)"]}]}
```

Cap at 500 entries, rotate.

### 12.4 Secret masking

Treat a value as secret if its key matches `/(key|token|secret|password|credential|auth)/i`
or the value looks like a credential (`sk-…`, `ghp_…`, `github_pat_…`, a JWT, 40+ chars of
base64). Render `••••••••`. Reveal is per-value, needs `v` on that row, reverts on
navigation. Never write a revealed secret to a log or the clipboard. Mask before any string
reaches a render.

### 12.5 Concurrency

The user may have Claude Code running while we write — that's the intended workflow (§5.6).
We can't lock. Mitigate: re-read immediately before every write, keep the read-mutate-write
window tiny, and watch our own files with `fs.watch` so the UI reflects external edits within
~500ms.

---

## 13. Build order

Each milestone ends with a working, testable app. Don't start the next until the current one
is manually verified.

**M1 — Detect and show.** Ink app, router, shared List, footer. `core/paths.ts` with correct
git-root resolution. `core/detect.ts`. Ladder screen renders real state. **Zero writes.** Use
it for a day before continuing.

**M2 — Write layer.** `core/write.ts` with the full §12.1 protocol, zod schemas, undo log,
backups, Repair. Test against deliberately malformed files. **No UI wired to it** — unit
tests only.

**M3 — Kit #11 first, end to end.** Kit loader, Preview, install, verify, uninstall,
transaction rollback — proven on the deletion warning (§9.5) before any other kit.

**Build this one first, deliberately.** Reasons, in order: it is the most valuable thing in
the whole app for a beginner; it exercises the hardest install path (a shell script that must
be executable, a settings patch, and a post-install self-check), so if the kit machinery
survives this it will survive the rest; and it is the only kit that produces a fifteen-second
GIF anyone will repost — *"AI deleted my production database"* is a story people already
know, and this is the answer to it. That GIF is the launch. Have it before you have ten kits.

**M4 — Two more kits, one of each shape.** Kit #3 (code reviewer, files only) and kit #6
(browser, MCP with network). Together with #11 these prove all three install paths. Verify
against a live Claude Code session that a kit lights up without a restart.

**M5 — The remaining seven kits.** Plus already-installed detection.

**M6 — Explore + Commands.** The writing (§11). This will take longer than you expect.

**M7 — Manage.** Toggles wired to M2.

**M8 — Spending + polish.** ccusage wrapper, first-run experience, help overlay, resize
handling, cold-start budget, README with the GIF from M3.

---

## 14. Acceptance tests

Done when all of these pass on Linux.

**Safety**
1. `settings.json` with a trailing comma → app refuses to write, routes to Repair, file is
   byte-identical after.
2. Install a kit, then uninstall → every file created is gone, every config key restored,
   **and no unrelated key in `settings.json` changed**, including unknown ones.
3. `SIGKILL` mid-write, 20 times in a loop → target file is always complete-old or
   complete-new, never truncated.
4. Kit install fails at step 3 of 4 → steps 1 and 2 are rolled back; disk is as before.
5. Config containing `"apiKey": "sk-ant-abc123"` renders `••••••••`; grep terminal output and
   undo log for `sk-ant` → zero hits.
6. Kit that appends to `CLAUDE.md` → uninstall removes only its fenced block; text the user
   added above and below survives.

**Correctness**
7. Started in `<repo>/src/deep/nested/`, writes land in `<repo>/.claude/`, not the nested dir.
8. A skill cycles all four states, each writing the correct `skillOverrides` value.
9. User-scope MCP server shows read-only; `Space` writes nothing.
10. With Claude Code running, an installed kit is usable in that session without a restart.
11. Installing a kit twice is detected and offered as uninstall, not duplicated.

**Deletion warning (kit #11)**
12. `rm -rf src/` with uncommitted changes → prompt appears and names the number of unsaved
    files.
13. `rm -rf node_modules/` → **no** prompt. (Alert fatigue is the failure mode; test the
    silence as hard as the noise.)
14. Feed the hook script malformed JSON, an empty stdin, and a 10MB payload → exits 0 every
    time, allows the call, never hangs.
15. Hook script `chmod -x` → install self-check catches it and reports, rather than silently
    installing something inert.
16. Session started with `--dangerously-skip-permissions` → the prompt still appears.
17. Hook runs in under 200ms on a repo with 10,000 files.

**Cost**
18. Ten minutes exercising every screen with network logging on → zero requests to
    `api.anthropic.com`.
19. Every token-costing command shows the warning before running.

**The one that matters**
20. Take someone who has used Claude Code but never made a skill. Hand them the terminal, say
    nothing. Within five minutes they install a kit and run the thing it told them to try. If
    they ask what any on-screen word means, **the word is wrong — fix it, don't explain it.**

---

## 15. Known risks

| Risk | Handling |
|---|---|
| Anthropic ships this natively | Likely within a year. Accept it. Keep kits as the durable asset — content outlives the shell. |
| Claude Code changes a settings key | Version-detect via `claude --version`; warn if untested; keep every §5 fact in one module. |
| A kit's files go stale against a new version | Kits are plain files in the repo — cheap to fix, easy for others to PR. |
| Warning fatigue in kit #11 |  Keep the pattern list tight; test the silences (#13) as hard as the alerts. |
| Kits feel patronising to experienced users | `--expert` flag skips explanations. Never nag. |
| We duplicate `/doctor` | Don't. Point at it. |
| MCP registry is in preview and may break | Timeout + graceful failure; the rest of the app works without it. |
| Writing `~/.claude.json` corrupts an OAuth session | v1 never writes it. Don't add this without a redesign. |
| The writing is mediocre | The single biggest failure mode. Test #20 is the gate. |

---

## 16. Plain-language glossary

`src/data/plain-names.json` — the file that makes the product work.

| Claude Code says | We say |
|---|---|
| MCP server | a tool |
| Skill | an ability |
| Subagent | a helper |
| Slash command | a command |
| Connector | a tool from claude.ai |
| Plugin | a bundle |
| Hook | something that runs automatically |
| Scope | which folders this applies to |
| User scope | all your folders |
| Project scope | this folder |
| Local scope | this folder, just for you |
| `settings.json` | your setup |
| `CLAUDE.md` | your project instructions |
| Context window | Claude's memory for this conversation |
| Compact | shrink the conversation |
| Token | *(never shown — convert to dollars or "memory")* |
| Marketplace | a place to find more tools |
| `disable-model-invocation` | Claude won't reach for this on its own |
| `skillOverrides` | *(never shown)* |

Also holds curated one-line descriptions for the ~50 most common MCP servers, so a beginner
installing `postgres` sees *"Lets Claude query your database"* rather than
`npx -y @modelcontextprotocol/server-postgres`.

---

## 17. README paragraph

> **ccpanel** shows you what Claude Code can do that you aren't using yet, explains it in
> plain English, and sets it up when you press Enter. No jargon, no config files, no
> tutorials — arrow keys and Enter get you everywhere. It never talks to an AI and never
> spends your money; everything on screen is read from files already on your computer.
> `npx ccpanel`.
