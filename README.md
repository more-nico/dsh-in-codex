# DSH in Codex

<p align="center"><img src="assets/dsh-in-codex.svg" alt="DSH in Codex" width="280" /></p>

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents alongside your Codex chat. Watch their progress, tool calls and results in one side panel, then continue with the same conversation when you need a follow-up.

English · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [First task](#try-your-first-task) · [Model setup](#runtime-and-permissions) · [Tools](#tools) · [Installation guide](AGENT_INSTALL.md)

## What you can do

| Task | How it works |
| --- | --- |
| Implement a bounded change | Give a worker its own task and file scope while you continue in Codex. |
| Review or explore code | Use a read-only reviewer or explorer with restricted tools. |
| Follow progress | See streaming replies, tool records and completed results in a shared side panel. |
| Continue later | Correct a running task, queue follow-up work without interrupting, or restore a stopped conversation with its history. |
| Set model tiers for future tasks | Configure the Regular and Enhanced model slots, each with its own model and thinking level, plus concurrency limits from the panel settings entry. |

![Light and dark panel previews, synthetic data](docs/panel-preview.png)

## Quick start

You need **Codex desktop + Node.js + DSH**. The plugin connects to DSH on your own machine and uses a dedicated `dsh_in_codex` profile for model access and credentials. The two model slots and concurrency limits are stored separately in the plugin data directory. The user-level default is disabled; each project opts in separately.

| Component | Requirement |
| --- | --- |
| System | macOS |
| Node.js | 22.19 or later |
| DSH | Tested with 0.2.1-rc.2; other 0.2.x builds must pass the bridge capability check |
| Codex desktop | MCP Apps, per-call chat metadata and trusted plugin hooks |

### Let your agent set it up

Send this directly to Codex:

```text
Install DSH in Codex on this machine by following https://raw.githubusercontent.com/more-nico/dsh-in-codex/main/AGENT_INSTALL.md. Configure its dedicated dsh_in_codex profile using my local DSH authentication and model settings, verify the connection, and run a small read-only task.
```

The guide covers prerequisites, model configuration, plugin installation and a real first task. Authentication stays with your local DSH installation. Select the provider and model you want to use when they are not already configured.

<details>
<summary><b>Manual setup</b></summary>

#### 1. Prepare Node.js and DSH

With Node.js 22.19+ installed, check DSH or install the tested version:

```sh
node --version
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
dsh --version
```

#### 2. Prepare the plugin files

For the prebuilt ZIP, verify the checksum and extract it. Bundled dependencies mean no npm install or build is required:

```sh
shasum -a 256 -c SHA256SUMS
unzip dsh-in-codex-0.1.0-macos.zip
cd dsh-in-codex
```

For a source checkout, build it first:

```sh
git clone https://github.com/more-nico/dsh-in-codex.git
cd dsh-in-codex
npm ci
npm run build
```

#### 3. Configure your model

Use DSH's own authentication and configure the model in `~/.dsh/profiles/dsh_in_codex/cordis.patch.yml`. For a fresh setup, run `node bin/dsh-in-codex.mjs doctor` once to create the profile before editing it. Later launches preserve your settings. If your Web profile already has working models, explicitly import them with:

```sh
node scripts/import-web-models.mjs
```

You can also use **Settings → Migrate models from a DSH profile** in the panel. Select a source profile, then choose providers and individual models. An existing provider keeps its connection settings and receives only the selected new models; a model with the same ID is marked as configured and cannot be selected. Migration backs up the dedicated profile and does not copy the source's default model selection. Each user supplies their own model access; the distribution contains no personal provider settings or credentials. The Regular/Enhanced model slots and concurrency remain stored separately from the DSH profile.

#### 4. Check and install

```sh
node bin/dsh-in-codex.mjs doctor
node bin/dsh-in-codex.mjs install --project /path/to/project
```

The installer refreshes the plugin and its Codex cache, keeping the panel discoverable globally. **DSH tasks default to off in new projects.** Only an explicit enabled entry in the current project's `.codex/config.toml` grants access. `install --project` enables that project; plain `install` does not enable any project.

Ask Codex “Enable dsh in codex for this project”, or run:

```sh
node bin/dsh-in-codex.mjs project enable --project /path/to/project
node bin/dsh-in-codex.mjs project disable --project /path/to/project
node bin/dsh-in-codex.mjs project status --project /path/to/project
```

Omitting `--project` uses the current directory. The enable command writes:

```toml
[plugins."dsh-in-codex@local-plugins"]
enabled = true
```

The project must be trusted by Codex. A disabled project may see the panel, but its task calls, model probes and history reads are rejected. Access follows the main chat's project, regardless of a task's `cwd`. Other projects and trust settings are not rewritten. Reload Codex after updating the plugin so its panel and hooks use the new version.

Editing or rebuilding this checkout later does not update the installed copy or Codex's plugin cache; rerun install with the same options.

Restart or reload Codex (or reopen the project), approve the project trust prompt if shown, review and trust its hooks, then start a new turn.

`doctor` checks the runtime and bridge. The first task below also verifies model authentication and result delivery. `install --codex-home /path/to/codex-home` supports isolated installs; use the same option for uninstall. Transcripts are retained.

</details>

### Try your first task

Once installed, ask Codex:

```text
Use DSH in Codex to create a read-only child that reads this project's README.md and summarizes its purpose in three sentences. Show its progress in the side panel, wait for the result, and release the child process when finished. Do not modify any files.
```

Codex creates a DSH conversation, opens the panel when needed, and receives the completed result in the parent chat. Codex first calls `dsh_models` to discover the two configured slots, then explicitly selects Regular (`slot1`) for general work or Enhanced (`slot2`) for complex tasks or deeper reasoning. An explicit `model` always wins; when the selected slot is empty, DSH's native configuration applies. Instructions and follow-ups stay in the Codex chat; the panel shows progress and history.

Open the panel's settings (gear) entry to configure the Regular and Enhanced slots (model and thinking each) and global/per-chat concurrency limits. Model choices apply only to later spawns; concurrency limits affect later scheduling.

To continue, ask: “Use the same DSH child to explain the installation steps.” Its native session is restored even after the child process has been released.

## Runtime and permissions

Each child launches `dsh --profile dsh_in_codex --patch <private-bridge-overlay>`. First use initializes the dedicated profile from DSH's shipped runtime bundles. The overlay loads this project's native bridge; subsequent launches preserve the profile's configuration.

- Provider access, custom models and credentials come from the **dsh_in_codex profile**. The two model slots and concurrency limits are separate: the panel settings entry stores them in `settings.json` in the plugin data directory, not in the DSH profile or Web profile. There is no separate plugin default model or default thinking level. DSH owns login and credentials. Web-profile models and plugins are not imported automatically.
- `npm run import:web-models` explicitly merges Web model adapters and the default selection into the dedicated profile, preserving its other settings and backing up the original file. Credentials stay in the native DSH credential store; the script never prints keys or writes configuration into this repository/release.
- Spawn-time model precedence is explicit `model` > selected non-empty `preset` (`slot1` Regular / `slot2` Enhanced) > DSH native. Each slot stores `{provider,id,thinking}`; the main chat calls `dsh_models` to discover the configured slots and their `source`, then explicitly chooses a slot for the task. A call with only `name`/`task` remains compatible and uses DSH's native selection. Regular and Enhanced are user-configured roles, not inferred tiers: both slots are independent, may use the same model with different efforts (for example Regular high and Enhanced max) or be identical, and never auto-upgrade. Selection is literal, with no routing from task text and no strength inference from names such as “Fast”; `thinking` must be supported by the selected model. The main chat can still choose any model configured in the dedicated profile explicitly.
- Model choices retain `{provider,id,thinking}`. `thinking` maps to native reasoning effort; a plain `dsh_models` call returns `{presets,settings,effective,all_models}` without a temporary selected model. Each `all_models` entry includes `provider`, `id`, `name`, `contextWindow`, `input`, and `reasoningEfforts` from DSH's resolved model information; unavailable metadata is `null`. Pass `model: {provider,id}` to receive `probe.thinkingLevels` for that model. `dsh_settings` is app-only and only the panel can change settings.
- **Workers default to full access**, using DSH's `danger-full-access` preset. They can modify files available to the current user and do not inherit the Codex sandbox.
- **Reviewer/explorer are read-only**: native read-only permissions, a tool allowlist and a deny-only execution guard. Allowed tools are `read`, `grep`, `glob`, available `find`/`ls`, and the injected `dsh_report`. Shell, writes, delegation and other tools are blocked, including nested dispatch.
- Settings affect only subsequent spawns; saving never switches a running task's model. Concurrency changes affect later scheduling, and lowering a limit never terminates running tasks.
- Children receive only explicitly supplied context and share the selected directory. The plugin adds no per-directory concurrency control; assign disjoint write scopes to concurrent tasks.

## Tools

<details>
<summary><b>All 19 MCP tools and their behavior</b></summary>

The 17 original Pi tools are retained under the `dsh_` prefix. Intentional interface changes are the optional `preset` on `dsh_spawn` and the `followUp` default on `dsh_send`. `dsh_settings` and `dsh_model_migration` are app-only tools for the panel settings page.

| Tool | Purpose |
| --- | --- |
| `dsh_spawn` | Create a child; requires name/task, supports context/cwd/model/preset/profile/path/group/requestId |
| `dsh_list` | List current-chat children, with path/group/archive filters |
| `dsh_read` | Read recent messages, tools, partial replies, history or exact text pages |
| `dsh_send` | Queue follow-up (default), steer explicitly, or resume a settled conversation |
| `dsh_stop` | Stop and release the process; preserve history |
| `dsh_wait` | Wait for selected agents with an explicit timeout |
| `dsh_ack` | Acknowledge consumed completions or mailbox events |
| `dsh_reply` | Answer a pending question or permission request from the parent |
| `dsh_message` | Correct a deviating running child without waking an idle one |
| `dsh_follow_up` | Queue follow-up without steering; continue or repair after completion |
| `dsh_interrupt` | Cancel current activity and retain a responsive process; fall back to stop |
| `dsh_events` | Read the durable mailbox by cursor or exact event ID |
| `dsh_result` | Page a full result by stable completion ID, including older runs |
| `dsh_models` | Discover configured model slots, models, efforts, and settings/effective limits |
| `dsh_settings` | App-only panel settings: Regular/Enhanced model slots and global/per-chat concurrency |
| `dsh_model_migration` | App-only profile listing, model preview, and selected model import |
| `dsh_archive` | Archive/restore settled children while retaining history and results |
| `dsh_panel` | Open one shared read-only panel per chat |
| `dsh_poll` | App-only incremental long polling |

`dsh_settings`, `dsh_model_migration`, and `dsh_poll` are app-only; `dsh_report` is a child-side tool, not an MCP tool. The task panel has no input form; the settings page is the only form and does not send chat instructions.

Use `dsh_message` or an explicit `dsh_send` steer only to correct a child that has left its task or scope. If new work arrives before the current run has settled, queue it with `dsh_follow_up` (or `dsh_send` without `mode`, which defaults to `followUp`); it waits, stays FIFO and never interrupts. Use `dsh_follow_up` for additions or repairs after completion.

Waits require `agentIds` and `timeoutMs` in **0–3,600,000 ms**. Completion, messages and input can return early; timeout does not stop work. Pass `afterCursor` across waits, optionally pin `runIds`, fetch truncated results through `dsh_result`, then acknowledge consumed IDs. Reads do not acknowledge results.

Question batches become separate dialogs and are combined when all answers arrive. Single-choice `value` accepts a label or free text. Multi-select uses a JSON array such as `["A","B"]`, or `{"selected":["A"],"custom":"details"}`. Permission dialogs require explicit `confirmed`; cancellation uses `cancelled:true`. Expired replies are rejected.

</details>

## Lifecycle and configuration

<details>
<summary><b>Scheduling, recovery and environment variables</b></summary>

The saved global/per-chat limits control fair scheduling. With no saved settings or environment override, factory defaults are 10 active children globally and 5 per chat; both remain panel-adjustable from 1 to 32. An existing `settings.json` always wins, and upgrades preserve explicitly saved limits instead of forcing them back to 10/5. Waiting for input occupies a slot. Raising a limit can admit queued work, while lowering it never preempts running tasks. SessionStart, UserPromptSubmit, PostToolUse and Stop hooks deliver results at safe points to the original chat; idle parents are not actively woken. Missing host chat metadata fails rather than guessing from a directory or process environment.

Completion waits for native root activity, progressing descendants, event delivery and persistence. Prompt admission, an assistant reply or a temporary idle transition is not completion. Idle processes are reclaimed after five minutes and resume from native DSH persistence. Daemon restart marks unfinished runs interrupted and never silently replays them.

| Variable | Default |
| --- | --- |
| `DSH_IN_CODEX_DSH_PATH` | dsh on PATH |
| `DSH_IN_CODEX_NODE_PATH` | Node path recorded by installer |
| `DSH_IN_CODEX_DATA_DIR` | `${CODEX_HOME:-~/.codex}/dsh_in_codex` |
| `DSH_IN_CODEX_SOCKET` | Private Unix socket derived from the data directory |
| `DSH_IN_CODEX_CONCURRENCY` | 10 (1–32) |
| `DSH_IN_CODEX_CHAT_CONCURRENCY` | 5 (1–32) |
| `DSH_HOME` | DSH's own default home |

The concurrency variables seed first-run limits; after the first save, `settings.json` in `DSH_IN_CODEX_DATA_DIR` wins. Existing saved limits are preserved across upgrades and are not reset to the 10/5 factory defaults. Plugin settings are written atomically with mode 0600 and the stored settings object contains only `presets.slot1`, `presets.slot2`, `maxConcurrent` and `maxPerThread`—model identifiers/effort and integers, no credentials. A legacy `defaultModel` is read only while migrating an older file, fills empty slots without overwriting existing ones, and is not written back as a third default. Settings persist across daemon restarts and upgrades.

Plugin state includes task text and tool output and is private to the local user. DSH owns its native logs. Credentials are not copied into the panel. Pi history is not migrated.

```sh
node bin/dsh-in-codex.mjs doctor
node bin/dsh-in-codex.mjs daemon-stop
node bin/dsh-in-codex.mjs uninstall
```

Upgrade/reinstall/uninstall stops this plugin's daemon. The installer waits for the old instance to exit before replacing files; restart Codex after upgrading.

</details>

## Develop

```sh
npm run check
npm run dev:ui
npm run pack:plugin
```

`http://127.0.0.1:4173/?demo=1` uses synthetic data; `/preview.html` compares narrow light/dark panels. The original 50-message pages, approximately 4 Hz refresh, 8,000-character previews and 16,000-character detail pages are retained; stored records stay complete.

Tests retain the essential project access, chat isolation, task lifecycle/queue, model settings and message rendering behavior. They use local fake runtimes, not live providers. See [test scope](docs/VALIDATION.md), [panel behavior](docs/INTERFACE.md) and [coordination semantics](docs/SUBAGENT_PARITY.md).

Based on [Pi in Codex](https://github.com/more-nico/pi-in-codex) at `1d78d8a`, retaining its interface and 17 original MCP tools with native DSH agents. The app-only `dsh_settings` and `dsh_model_migration` tools, model slots, and concurrency limits are additions. DSH children are external conversations rather than native Codex subagents. Both plugins can be installed together.

The DeepSeek whale-girl (DeepSeek 鲸鱼娘) pixel logo comes from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI), MIT; attribution, pinned provenance and the complete license are included.

Independent community project; not affiliated with or endorsed by OpenAI or DeepSeek. MIT; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
