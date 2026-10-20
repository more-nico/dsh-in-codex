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
| Continue later | Steer running work, ask a follow-up, or restore a stopped conversation with its history. |

![Light and dark panel previews, synthetic data](docs/panel-preview.png)

## Quick start

You need **Codex desktop + Node.js + DSH**. The plugin connects to DSH on your own machine and uses a dedicated `dsh_in_codex` profile for model settings.

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

The importer backs up the dedicated profile before merging model adapters and the default selection. Each user supplies their own model access; the distribution contains no personal provider settings or credentials.

#### 4. Check and install

```sh
node bin/dsh-in-codex.mjs doctor
node bin/dsh-in-codex.mjs install
```

Restart Codex, install and enable **DSH in Codex** from the local marketplace, review and trust its hooks, then start a new turn. The installer backs up and merges marketplace entries and installs to `~/.codex/plugins/dsh-in-codex`.

`doctor` checks the runtime and bridge. The first task below also verifies model authentication and result delivery. `install --codex-home /absolute/test/home` supports isolated installs; use the same option for uninstall. Transcripts are retained.

</details>

### Try your first task

Once installed, ask Codex:

```text
Use DSH in Codex to create a read-only child that reads this project's README.md and summarizes its purpose in three sentences. Show its progress in the side panel, wait for the result, and release the child process when finished. Do not modify any files.
```

Codex creates a DSH conversation, opens the panel when needed, and receives the completed result in the parent chat. Your selected DSH model performs the task. Instructions and follow-ups stay in the Codex chat; the panel shows progress and history.

To continue, ask: “Use the same DSH child to explain the installation steps.” Its native session is restored even after the child process has been released.

## Runtime and permissions

Each child launches `dsh --profile dsh_in_codex --patch <private-bridge-overlay>`. First use initializes the dedicated profile from DSH's shipped runtime bundles. The overlay loads this project's native bridge; subsequent launches preserve the profile's configuration.

- Defaults, custom providers and model configuration come from the **dsh_in_codex profile**. DSH owns login and credentials. Web-profile models and plugins are not imported automatically.
- `npm run import:web-models` explicitly merges Web model adapters and the default selection into the dedicated profile, preserving its other settings and backing up the original file. Credentials stay in the native DSH credential store; the script never prints keys or writes configuration into this repository/release.
- Model overrides retain `{provider,id,thinking}`. `thinking` maps to native reasoning effort; `dsh_models` discovers current models and supported efforts without sending a model prompt.
- **Workers default to full access**, using DSH's `danger-full-access` preset. They can modify files available to the current user and do not inherit the Codex sandbox.
- **Reviewer/explorer are read-only**: native read-only permissions, a tool allowlist and a deny-only execution guard. Allowed tools are `read`, `grep`, `glob`, available `find`/`ls`, and the injected `dsh_report`. Shell, writes, delegation and other tools are blocked, including nested dispatch.
- Children receive only explicitly supplied context and share the selected directory. Assign disjoint write scopes to concurrent tasks.

## Tools

<details>
<summary><b>All 17 tools and their behavior</b></summary>

All 17 Pi tool names are renamed from `pi_` to `dsh_`, retaining parameters, result shapes and visibility.

| Tool | Purpose |
| --- | --- |
| `dsh_spawn` | Create a child; requires name/task, supports context/cwd/model/profile/path/group/requestId |
| `dsh_list` | List current-chat children, with path/group/archive filters |
| `dsh_read` | Read recent messages, tools, partial replies, history or exact text pages |
| `dsh_send` | Steer, queue follow-up, or resume a settled conversation |
| `dsh_stop` | Stop and release the process; preserve history |
| `dsh_wait` | Wait for selected agents with an explicit timeout |
| `dsh_ack` | Acknowledge consumed completions or mailbox events |
| `dsh_reply` | Answer a pending question or permission request from the parent |
| `dsh_message` | Pass information without waking an idle child |
| `dsh_follow_up` | Explicitly continue or queue another task |
| `dsh_interrupt` | Cancel current activity and retain a responsive process; fall back to stop |
| `dsh_events` | Read the durable mailbox by cursor or exact event ID |
| `dsh_result` | Page a full result by stable completion ID, including older runs |
| `dsh_models` | Discover or probe native models and reasoning efforts |
| `dsh_archive` | Archive/restore settled children while retaining history and results |
| `dsh_panel` | Open one shared read-only panel per chat |
| `dsh_poll` | App-only incremental long polling |

`dsh_report` is a child-side tool, not an eighteenth MCP tool. The panel has no input form; control stays in the Codex parent chat.

Waits require `agentIds` and `timeoutMs` in **0–3,600,000 ms**. Completion, messages and input can return early; timeout does not stop work. Pass `afterCursor` across waits, optionally pin `runIds`, fetch truncated results through `dsh_result`, then acknowledge consumed IDs. Reads do not acknowledge results.

Question batches become separate dialogs and are combined when all answers arrive. Single-choice `value` accepts a label or free text. Multi-select uses a JSON array such as `["A","B"]`, or `{"selected":["A"],"custom":"details"}`. Permission dialogs require explicit `confirmed`; cancellation uses `cancelled:true`. Expired replies are rejected.

</details>

## Lifecycle and configuration

<details>
<summary><b>Scheduling, recovery and environment variables</b></summary>

Fair scheduling defaults to four active children globally and two per chat. Waiting for input occupies a slot. SessionStart, UserPromptSubmit, PostToolUse and Stop hooks deliver results at safe points to the original chat; idle parents are not actively woken. Missing host chat metadata fails rather than guessing from a directory or process environment.

Completion waits for native root activity, progressing descendants, event delivery and persistence. Prompt admission, an assistant reply or a temporary idle transition is not completion. Idle processes are reclaimed after five minutes and resume from native DSH persistence. Daemon restart marks unfinished runs interrupted and never silently replays them.

| Variable | Default |
| --- | --- |
| `DSH_IN_CODEX_DSH_PATH` | dsh on PATH |
| `DSH_IN_CODEX_NODE_PATH` | Node path recorded by installer |
| `DSH_IN_CODEX_DATA_DIR` | `${CODEX_HOME:-~/.codex}/dsh_in_codex` |
| `DSH_IN_CODEX_SOCKET` | Private Unix socket derived from the data directory |
| `DSH_IN_CODEX_CONCURRENCY` | 4 (1–32) |
| `DSH_IN_CODEX_CHAT_CONCURRENCY` | 2 (1–32) |
| `DSH_HOME` | DSH's own default home |

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
# Explicit live-model smoke test; consumes configured model quota:
node --import tsx scripts/smoke-dsh.ts --quick
```

`http://127.0.0.1:4173/?demo=1` uses synthetic data; `/preview.html` compares narrow light/dark panels. The original 50-message pages, approximately 4 Hz refresh, 8,000-character previews and 16,000-character detail pages are retained; stored records stay complete.

Regular tests exercise process/stdio/socket/MCP/hooks and installation. If dsh is installed, they also drive the **real native runtime with a keyless mock model**; otherwise this integration test explicitly skips. Live-provider tests are separate. See [validation](docs/VALIDATION.md), [panel behavior](docs/INTERFACE.md) and [coordination semantics](docs/SUBAGENT_PARITY.md).

Based on [Pi in Codex](https://github.com/more-nico/pi-in-codex) at `1d78d8a`, retaining its interface and 17 MCP tool contracts with native DSH agents. DSH children are external conversations rather than native Codex subagents. Both plugins can be installed together.

The DeepSeek whale-girl (DeepSeek 鲸鱼娘) pixel logo comes from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI), MIT; attribution, pinned provenance and the complete license are included.

Independent community project; not affiliated with or endorsed by OpenAI or DeepSeek. MIT; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
