# Subagent invocation and behavior

DSH integration baseline: 0.2.1-rc.2, 2026-10-20.
Codex tool families can vary by runtime; these are not ordinary sidebar chats.

| Creation input | Codex spawn_agent | dsh_spawn |
| --- | --- | --- |
| Required | task_name, message | name, task |
| Background | fork_turns all/none; defaults to all in this runtime | Explicit context; parent transcript never copied |
| Model | Inherits parent unless overridden | Uses DSH defaults unless provider/id/thinking supplied |
| Directory | Parent execution environment | Parent cwd unless an absolute existing cwd supplied |
| Permissions/tools | Host-managed parent configuration | DSH's own configuration; optional inspection tool gate |
| Recommended task brief | Objective, boundaries, output and validation | Same, plus explicit background the parent wants to share |

DSH additionally accepts profile, path, group and an optional requestId retry key.
Creating DSH does not need a user-supplied threadId, credential or transcript.
The host supplies chat identity; DSH manages its own credentials.

## Coordination

- dsh_message does not start an idle child. dsh_follow_up explicitly starts/queues
  another task. dsh_send remains backward compatible with steer/followUp/resume.
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

The global default is four active agents, each chat defaults to two. Set
DSH_IN_CODEX_CONCURRENCY and DSH_IN_CODEX_CHAT_CONCURRENCY to override (1–32).
Eligible chats are scheduled by least recent service, FIFO within a chat.
Running jobs are not preempted. Waiting for input occupies a slot. Lists expose
queuePosition/queueReason without expanding transcripts.

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
parent; the panel remains read-only. Profile/default model configuration is
independent from the Web profile. Trusted DSH plugins remain trusted process
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
