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

## 3. Register and enable the plugin

```sh
node bin/dsh-in-codex.mjs doctor
node bin/dsh-in-codex.mjs install
```

The installer writes the plugin to `~/.codex/plugins/dsh-in-codex`, records
the current Node executable and merges a backed-up local marketplace entry.
With the Codex CLI available, install and enable that entry with:

```sh
codex plugin add dsh-in-codex@local-plugins --json
```

Otherwise use the local source in Codex's plugin directory. Restart Codex to
refresh discovery, then review and trust the plugin's four hook types. If the
current runtime cannot operate Codex's own UI, explain the exact remaining
step to the user. Preserve unrelated plugins, marketplace entries and settings.

## 4. Run a first real task

In the refreshed Codex chat, verify that the `dsh-agents` skill and `dsh_*`
tools are available. Use `dsh_models` to discover the default model, then
create one small read-only child with the explorer profile. For example:

```text
Read this project's README.md and summarize its purpose in three sentences.
Do not modify files, read credentials, run shell commands or delegate work.
```

Use `dsh_panel` when `panel.shouldOpen` requests it. Wait for `agent_settled`
completion via `dsh_wait`, inspect and acknowledge the result, then release
the child process with `dsh_stop`. The test uses the user's model quota.

## 5. Report the result

Report the installed version, dedicated profile name, selected provider/model,
bridge status and actual task outcome. Distinguish installation, model
authentication and live panel discovery. State any remaining restart or hook
trust step accurately; do not claim an unobserved UI check passed.
