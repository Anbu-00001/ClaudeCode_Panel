# ccpanel

**ccpanel** shows you what Claude Code can do that you aren't using yet, explains it in plain
English, and sets it up when you press Enter. No jargon, no config files, no tutorials — arrow keys
and Enter get you everywhere. It never talks to an AI and never spends your money; everything on
screen is read from files already on your computer.

```
npx ccpanel
```

Not on npm yet — until it is, see [Run it in any folder](#run-it-in-any-folder) below.

---

## What it does

Most people install Claude Code, point it at a repo, and stop there. A June 2026 study of 2,500
public repositories found 84.9% have a `CLAUDE.md`, but only 28.1% have ever made a skill and only
13.3% use hooks. Each rung up loses roughly a third of the field.

That gap isn't *"I have twelve tools and can't manage them."* It's *"I didn't know that existed."*
So ccpanel is a discovery tool first and a config manager second.

**The ladder** — open it in any project and it reads the folder to work out what you're already
using:

```
   You're using 5 of 9 things Claude Code can do.

   ✓ Project instructions   ✓ Permissions            · Commands
   ✓ Skills                 · Helpers                ✓ Tools
   ✓ Automatic checks       · Memory                 · Parallel work
```

**Kits** — a kit is a small bundle that sets up one useful thing end to end: files, settings, and
something to try, installed together by pressing Enter. You see every file that will be created and
every setting that will change *before* anything happens, and one keypress undoes it.

## The kits

| Kit | The problem it solves |
|---|---|
| Warns you before deleting anything big | Claude runs a command that deletes something you needed |
| Stops asking permission for safe things | So many approvals you stop reading them |
| Reviews your code before you commit | You finish a change and aren't sure what you missed |
| Writes your commit messages | You type "fix" because it's the last thing before you're done |
| Checks before changing something load-bearing | You asked for one change and got edits you never mentioned |
| Spots its own mistakes before saying it's done | You're the one who discovers it doesn't compile |
| Doesn't lose track when conversations get long | Claude forgets and redoes work you already finished |
| Finds its way around before changing anything | Claude reads twenty files and runs out of room |
| Say your prompt out loud | Typing is slower than thinking |
| Tests your site in a real browser | You changed something and don't know if the page works |

Kits are plain files in [`kits/`](kits/) — readable, reviewable, and easy to contribute.

## Safety

These are guarantees, not aspirations. Each one has tests.

- **It never spends your money.** Zero calls to any Anthropic API. Every number is arithmetic over
  local files. The only network calls are the MCP registry when you search, and `npx` during an
  install you started.
- **It never corrupts a config file.** Claude Code rejects an invalid settings file *entirely* — one
  stray comma kills every permission rule and hook you had. So every write reads, parses, snapshots,
  validates, writes to a temp file, renames atomically, then re-reads to confirm. A file that
  doesn't parse is never overwritten.
- **Everything is reversible.** Every kit uninstalls exactly what it added. Every toggle flips back.
- **Nothing installs without a preview.**
- **Secrets are masked** before they reach the screen, the logs, or the clipboard.

Verified by test, not by assertion: killing the process mid-write 20 times leaves the target file
complete-old or complete-new, never truncated; installing and uninstalling a kit leaves unrelated
settings byte-identical, including keys ccpanel has never heard of.

Linux only in v1.

## Run it in any folder

Do this once, from this folder:

```bash
npm run install-global
```

From then on, type one word wherever you happen to be:

```bash
ccpanel
```

Any folder works — a work project, your home folder, an empty directory, somewhere that isn't a git
repo at all. It reads whatever folder you are standing in when you type it.

To take the command away again:

```bash
npm run uninstall-global
```

**Three things worth knowing.**

*It never asks for your password.* The command goes in npm's own folder, which lives inside your
Node installation and already belongs to you. Nothing here uses `sudo`. If that folder isn't
somewhere your terminal looks, the installer says so and prints the one line to add to `~/.bashrc`
or `~/.zshrc`.

*It installs a copy, not a shortcut.* `npm run install-global` builds the app, packs up exactly the
files that would be published, and installs those. So editing the code here does not change the
`ccpanel` you type elsewhere — a half-finished edit can't break a command you were relying on. When
you do want your changes out there, run `npm run install-global` again.

*If you switch Node versions, install it again.* Version managers like nvm give each Node version
its own set of commands, so `nvm use` a different one and `ccpanel` isn't there. Run
`npm run install-global` on that version too, or `nvm reinstall-packages <the-old-version>`.

## Running it from source

```bash
git clone <this repo> && cd ccpanel
npm install
npm start          # or: npm run dev
npm test
```

Requires Node 22+, which Claude Code already needs.

## For maintainers

`src/data/commands.json` is built only from the
[official commands page](https://code.claude.com/docs/en/commands) — community "complete lists"
circulate commands that don't exist (`/godmode`, `/ghost`), and teaching a beginner to type nonsense
is worse than omitting something. A test asserts none of those ship.

```bash
npm run refresh-commands   # prints a diff; never writes
```

It deliberately doesn't auto-write: the plain-English wording is hand-written, and a scraper would
replace it all with documentation prose.

## License

MIT.
