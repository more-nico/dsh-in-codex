# Subagent invocation and behavior

DSH integration baseline: 0.2.1-rc.2, 2026-10-20.
Codex tool families can vary by runtime; these are not ordinary sidebar chats.

| Creation input | Codex spawn_agent | dsh_spawn |
| --- | --- | --- |
| Required | task_name, message | name, task |
| Background | fork_turns all/none; defaults to all in this runtime | Explicit context; parent transcript never copied |
| Model | Inherits parent unless overridden | Explicit model > selected preset > DSH native; no plugin default, automatic routing, or implicit tier upgrade |
| Preset | n/a | Optional slot1 (Regular, general) / slot2 (Enhanced, complex/deeper); user-defined roles, slots may be identical |
| Directory | Parent execution environment | Parent cwd unless an absolute existing cwd supplied |
| Permissions/tools | Host-managed parent configuration | DSH's own configuration; optional inspection tool gate |
| Recommended task brief | Objective, boundaries, output and validation | Same, plus explicit background the parent wants to share |

DSH additionally accepts profile, path, group and an optional requestId retry
key. Creating DSH does not need a user-supplied threadId, credential or
transcript. The host supplies chat identity; DSH manages its own credentials.

## Plugin settings and presets

Settings are global to the plugin and persist in `settings.json` in the plugin
data directory, separate from the dedicated DSH profile and the Web profile.
The stored settings object contains only presets.slot1 (Regular), presets.slot2
(Enhanced), maxConcurrent and maxPerThread; credentials remain native to DSH.
The concurrency environment variables seed first-run limits only; a saved
settings file wins after restart, and an upgrade preserves the user's saved
limits instead of resetting them to the factory values.

Project access is independent of model settings. The plugin stays enabled
globally for panel discovery; DSH task execution requires
`[plugins."dsh-in-codex@local-plugins"] enabled = true` in its
`.codex/config.toml` in the trusted main-chat project. Projects without that
explicit entry cannot execute DSH tasks, probe models or read task history,
even if their panel entry is visible. Ask Codex to enable the current project
or use the local `project enable` command. Task cwd does not grant access.
Reload Codex after updating the plugin to load its new panel and hooks.

Spawn model precedence is explicit model > selected non-empty preset (slot1
Regular / slot2 Enhanced) > native DSH. There is no plugin default model or
default thinking level in between. The main session calls dsh_models first to
discover the two configured slots and their source, then explicitly passes the
slot chosen for the task. A spawn that supplies only name/task remains
compatible and uses DSH's native selection. The main session can still pass any
model configured in the dedicated profile, bypassing presets. The roles are
user-configured, not inferred tiers: slots may contain the same model with
different thinking levels (for example Regular high and Enhanced max) or
identical values. Values are used literally: there is no routing from task text,
no inference from model names (such as "Fast"), and no automatic upgrade;
thinking is validated against that model.

The API remains slot1/slot2. Existing settings files load: a legacy defaultModel
is read only to fill empty slots, existing slots are preserved, and the rewritten
file uses the new shape without a third default.

Saving model settings affects only later spawns; a running task keeps the model
it started with. Saving concurrency limits affects later scheduling: raising a
limit can admit queued work, while lowering it never preempts or terminates
running tasks. dsh_settings is app-only and exposed only to the panel settings
entry; dsh_models returns the current settings and effective limits for
model-side discovery.

No per-directory concurrency limit is added. Agents share the selected
directory, so the parent plans non-overlapping write scopes.

## Coordination

- Use dsh_message or dsh_send mode=steer only to correct an executing child that
  dsh_read shows has left its task or scope; do not use either to add a new task.
- dsh_send defaults to followUp. dsh_follow_up always queues followUp. When new
  work arrives before the current run has fully converged, queue it with
  dsh_follow_up (or dsh_send without an explicit mode); it waits for settlement,
  remains FIFO and does not interrupt. Use dsh_follow_up to continue or repair
  completed work in the same conversation.
- dsh_message does not start an idle child; it only leaves a message for an
  explicit follow-up.
- dsh_interrupt uses abort and retains a responsive process; dsh_stop releases it.
- dsh_report is injected as a native DSH scoped tool. Its notifications become durable,
  chat-scoped events. Input requests and completions enter the same mailbox.
- dsh_wait accepts explicit timeoutMs up to one hour, runIds, afterCursor,
  mode any/all and wakeOnMessages. Reasons distinguish message/input/completed,
  replaced runs, timeout and cancellation. It never silently changes the run
  being awaited. Reuse the cursor to skip previously observed results.
- dsh_events pages event previews; eventId retrieves a complete notice. dsh_result
  pages full results by completionId, including older runs. dsh_ack acknowledges
  eventIds/completionIds; acknowledging either completion representation covers
  both. Reading alone is not acknowledgment.
- Hooks deliver bounded batches at safe points; an idle parent is not woken.
  Unacknowledged notices can return on a later turn. This provides recoverable,
  at-least-once delivery, not exactly-once effects or native host notifications.

## Scheduling and lifecycle

The saved global/per-chat limits drive scheduling. With no saved settings and
no environment override, factory defaults are 10 and 5; the panel accepts 1–32,
and DSH_IN_CODEX_CONCURRENCY / DSH_IN_CODEX_CHAT_CONCURRENCY seed a first run.
An existing saved limit wins and is never reset to those defaults by an upgrade.
Raising a limit can admit queued work; lowering it never preempts running jobs.
Waiting for input occupies a slot. Eligible chats are scheduled by least recent
service, FIFO within a chat. Lists expose queuePosition/queueReason without
expanding transcripts.

Paths are unique aliases within a chat. dsh_list supports pathPrefix/group.
dsh_archive hides only settled agents by default, preserves history and pending
results, and releases idle resources. Restore with archived=false or an explicit
follow-up; dsh_list includeArchived=true includes them.

## Inspection profiles

Workers use the dedicated `dsh_in_codex` profile tool roster with danger-full-access permissions.
Reviewer/explorer use native read-only permission, mask inherited tools to the
available read/grep/glob/find/ls entries, and register a monotonic guard that
also denies locally registered or nested unlisted tools. The local dsh_report
tool remains available. No shell or delegation is allowed for inspection.
The native bridge supplies ask_user_question through DSH's userQuestions seam
when the dedicated profile has no existing question tool. Replies are handled by the
parent; the task panel remains read-only. Profile/provider configuration and plugin
settings are independent from the Web profile. Trusted DSH plugins remain trusted process
code, and Codex sandbox permissions are not inherited.

The private JSONL bridge translates native Agent/session/stream events into
the original scheduler event contract. Completion waits through root idle,
managed progressing descendants, event output and a native durability flush,
then rechecks for newly admitted work. Each plugin run has a stable completion
ID; accepted prompts do not imply completion.

## Retry and recovery

requestId is supported on spawn/send/message/follow_up. Completed receipts replay
the original response for identical arguments, including across restarts. A key
with changed arguments is rejected. In-flight receipts restored after a crash
are uncertain and are not retried automatically; inspect dsh_list/dsh_read before
using a new key. A child/provider can still have performed work before a socket
or process failure, so exactly-once delivery is not claimed.
