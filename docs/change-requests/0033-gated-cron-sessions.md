# 0033 · Cron fires skipped by a gate leave empty sessions

**Serves:** The chat list in Boundary.
**Status:** Open

## Background

Read in the `nousresearch/hermes-agent:v0.23.1` image. A cron job whose job is not `no_agent` runs through `cron/scheduler_authority.py` `run_canonical_job`, which calls the gateway's `submit` (`gateway/session_cron.py`). `submit` commits a local session (`commit_local_session`) with `source: "cron"` before `run_job` starts. `run_job` then calls `_prepare_job_prompt`, which returns early when the monitor gate finds the output unchanged (`_apply_monitor_gate`), when a wake-gate script answers `wakeAgent: false`, or for an empty payload. Those returns come before the `try` whose `finally` calls `_finalize_cron_session`, the only place a cron session gets its title and `end_session`.

So every gated fire leaves a row with no title, no messages, no API calls and no end time. A job with a `monitor_url` every 15 minutes makes about 96 a day; one local stack had 998 of them. `startup_orphan_reap` ends them at the next restart but leaves them untitled. `session.list` returns them, while it leaves out empty sessions of other sources.

A person who opens one sees an empty chat. Typing into it ran a normal turn: `session.resume` gave a live session and `prompt.submit` answered, so the person's chat became a cron session.

## R1 · No session for a fire the gates skip (Wanted)

**Why:** each skipped fire adds an empty chat to every client's list.

**Ask:** run the monitor, wake and payload gates before `submit` commits the session, or have a gated fire finalize its session as hidden or delete it. Either way `session.list` stops returning it.

**Acceptance:** a `monitor_url` job whose output does not change fires 3 times and adds no row to `session.list`; a fire whose output changed lists one titled session.

**Boundary fallback:** `listSessions` leaves out rows with `source: "cron"` and `message_count: 0`.

## R2 · A cron session refuses a person's turn (Wanted)

**Why:** `gateway.errors.cron_session_read_only` exists for this, but the resume path skips it.

**Ask:** `prompt.submit` on a session whose source is `cron` answers with that error, whichever path made the session live.

**Acceptance:** `session.resume` on a cron session, then `prompt.submit`, returns the read-only error and stores no message.

**Boundary fallback:** none beyond R1's filter, which keeps empty cron sessions out of reach. A cron session that ran its agent can still be opened and typed into.
