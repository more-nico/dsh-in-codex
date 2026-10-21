# Install DSH in Codex with an agent

Use this guide when the user asks you to install this project. The canonical
repository is https://github.com/more-nico/dsh-in-codex and its default branch
is `main`. The prebuilt ZIP includes this guide and the runtime bundles;
a source checkout needs a build.

## 0. Get the project

If you opened this guide through its GitHub URL and do not already have the
project locally, clone it first:

```sh
git clone https://github.com/more-nico/dsh-in-codex.git
cd dsh-in-codex
```

If the user already downloaded a ZIP or cloned the repository, use that
directory. Check an existing checkout before reusing it; preserve local
changes and do not overwrite an unrelated directory. Run the commands below
from the project root.

## 1. Check the environment

- Supported host: macOS and Codex desktop with MCP Apps and trusted hooks.
- Check `node --version`; Node.js 22.19+ is required.
- Check `dsh --version`; the tested baseline is 0.2.1-rc.2. If DSH is missing,
  install it with `npm install -g @deepseek-ai/dsh@0.2.1-rc.2`.
- If `dist/cli.mjs` is missing in a source checkout, run `npm ci` followed by
  `npm run build`. An extracted ZIP requires neither command.

## 2. Prepare the dedicated DSH profile

The runtime always launches `dsh --profile dsh_in_codex`. First use initializes
`$DSH_HOME/profiles/dsh_in_codex` (default `~/.dsh/profiles/dsh_in_codex`) from
DSH's shipped bundles. Later launches preserve its existing settings. Each
child has an independent native session and process; they share this profile.

Run `node bin/dsh-in-codex.mjs doctor` to initialize and inspect the bridge.
Do not treat a bridge handshake as proof that model authentication works.

Use the user's own DSH authentication and model access. If the dedicated
profile already has a working configuration, retain it. If the user wants to
reuse their configured Web models, run:

```sh
node scripts/import-web-models.mjs
```

This explicitly imports model adapters and the default model from the Web
profile into `dsh_in_codex`, backing up its original overrides. Credentials
stay in DSH's native credential store. Other profiles remain independent.
If model choice or authentication is missing, ask the user for the provider
and model, and use DSH's own authentication flow. Do not ask the user to paste
keys into the chat or include personal configuration in the project/ZIP.

Plugin-level settings are separate from the dedicated profile. Two model slots
(Regular `slot1` for general tasks, Enhanced `slot2` for complex tasks/deeper
reasoning; each storing provider/id/thinking) and global/per-chat concurrency
(each panel-adjustable 1–32, with factory defaults of 10 and 5 when no settings
have been saved and no environment override is set) are edited from the panel's
settings (gear) entry. There is no separate plugin default model or default
thinking level. These settings persist in `settings.json` under the plugin data
directory (`DSH_IN_CODEX_DATA_DIR`, default
`${CODEX_HOME:-~/.codex}/dsh_in_codex`), never in the DSH profile, Web profile or
the repository. The stored settings contain only the two presets and the
concurrency limits; a legacy `defaultModel` fills empty slots during migration
and is not kept as a third default. `dsh_settings` is app-only; use `dsh_models`
to inspect the two configured slots, models, supported efforts, and current
settings/effective limits. Saving validates model and thinking choices against
the dedicated profile; it never switches a running task's model, and lowering
concurrency never terminates running work. Do not claim to have changed plugin
settings unless the panel save was observed.

## 3. Install with project scope

```sh
node bin/dsh-in-codex.mjs doctor
node bin/dsh-in-codex.mjs install --project /path/to/project
```

Pass the user's project directory, not this plugin checkout unless the user
explicitly wants the plugin enabled there; `$PWD` is correct only when the shell
is already in that project.

The installer copies this checkout or release into the Codex plugin location
(`~/.codex/plugins/dsh-in-codex` by default), refreshes the per-version plugin
cache Codex reads, records the current Node executable, and backs up and merges
the local marketplace entry. It prefers `codex plugin add` and falls back to a
direct cache copy. The user-level plugin stays enabled for panel discovery;
DSH task access requires an explicit project opt-in. `--project` enables only
that project; without it, no project opt-in is added. Other projects are not modified.

Manage the project opt-in without reinstalling:

```sh
node bin/dsh-in-codex.mjs project enable --project /path/to/project
node bin/dsh-in-codex.mjs project disable --project /path/to/project
node bin/dsh-in-codex.mjs project status --project /path/to/project
```

For these commands, omitting `--project` uses the current directory.
`project enable` keeps panel discovery enabled globally and grants DSH task access
only to that project. Projects without their own explicit entry cannot use DSH.
`project disable` overrides only that project and does not change the user-level
default. `project status` reports the effective state and any trust warning.
These project commands change configuration only; they do not install files or
refresh the cache. Both the install and project forms accept
`--codex-home /path/to/codex-home` for an isolated Codex home. The project entry
is in the project's `.codex/config.toml`:

```toml
[plugins."dsh-in-codex@local-plugins"]
enabled = true
```

The project must be trusted by Codex. The backend checks the main chat's project
before task calls, model probes, or history reads. A task's cwd cannot grant access.
The panel may appear in other projects, but those projects cannot execute DSH work.
The installer does not change trust or permissions.

The installer refreshes the cache. If it reports a cache warning, re-run
the same install command; when the warning names
`codex plugin add dsh-in-codex@local-plugins --json`, run that command and
re-check. Do not add a user-level enable yourself.

Keep the project entry local for a personal opt-in, or commit it when the
repository should share the opt-in. After changing scope, restart or reload
Codex (or reopen the project) so it reloads `config.toml` and rediscovers the
plugin's skills, MCP server and hooks. Existing sessions do not have
already-loaded tools removed in place; do not claim that disabling unloads
another active chat immediately. Approve the project trust prompt if shown, then
review and trust the plugin's four hook types before the first task.

On upgrade, a previous user-level `enabled = true` is reset to disabled. Other
projects' configuration files are not modified; a project remains enabled only
through its own project entry.

Editing or rebuilding this checkout does not, by itself, update the installed
plugin or Codex's per-version plugin cache. The installer copies files at
install time; rerun the same install command after a rebuild.

If the current runtime cannot operate Codex's own UI, explain the exact remaining
step to the user. Preserve unrelated plugins, marketplace entries and settings.

## 4. Run a first real task

In the refreshed Codex chat, verify that the `dsh-agents` skill and `dsh_*`
tools are available. Call `dsh_models` first to discover the two configured
slots and available models, then choose the slot explicitly for the task and
pass it as `preset`. Use Regular `slot1` for general work and Enhanced `slot2`
for complex tasks or deeper reasoning. For this small read-only check, pass
`preset: "slot1"`. For example:

```text
Read this project's README.md and summarize its purpose in three sentences.
Do not modify files, read credentials, run shell commands or delegate work.
```

An explicit `model` always wins; otherwise the explicitly selected non-empty
preset applies, and an empty slot uses DSH's native configuration. There is no
plugin default between them. A call with only `name`/`task` and no preset remains
supported and uses DSH's native selection. The roles are user-configured, not
inferred tiers: the slots may use the same model with different effort (for
example Regular high and Enhanced max) or be identical. Do not infer strength
from model names, auto-upgrade, or route from task text. If more work arrives
while the child is still running, queue it with `dsh_follow_up`; use
`dsh_message` or an explicit steer only to correct a deviation, never to
interrupt with a new task. After completion, use `dsh_follow_up` for additions
or fixes. No per-directory concurrency control is added; keep concurrent write
scopes disjoint.

Use `dsh_panel` when `panel.shouldOpen` requests it. Wait for `agent_settled`
completion via `dsh_wait`, inspect and acknowledge the result, then release
the child process with `dsh_stop`. The test uses the user's model quota.

## 5. Report the result

Report the installed version, dedicated profile name, selected provider/model,
bridge status and actual task outcome. State which slot (or explicit model) the
first task used, whether both slots and concurrency were configured in the panel
or left empty/native, and distinguish installation, model authentication and
live panel discovery. State which project was enabled, whether its
`.codex/config.toml` entry is local or shared, and whether trust or a reload is
still pending. State any remaining restart or hook trust step accurately; do not
claim an unobserved UI check passed, that source edits updated the installed
copy, or that already-open chats were immediately unloaded.
