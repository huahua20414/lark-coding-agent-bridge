# Resume Codex History Preview Design

## Goal

When a Feishu user resumes a Codex session with `/resume use <nonce>` or the resume card button,
the bridge should restore the Codex thread, send one relevant transcript message back to Feishu, and
follow an in-progress turn until it completes.

## Scope

- Codex only.
- Private chats only; group and topic chats keep the existing non-disclosing behavior.
- Show one message only.
- Prefer the message from an in-progress turn; otherwise show the latest user or assistant message.
- If the resumed thread is in progress, poll it every 2 seconds until it completes.
- Stop polling after 20 minutes.
- Resume must still succeed if history preview loading fails.

## Design

- Add a Codex app-server helper that calls `thread/read` with `includeTurns: true`.
- Parse only `userMessage` and `agentMessage` items.
- Flatten text input content conservatively and skip tool, reasoning, and command items.
- Pick the newest in-progress turn first, preferring assistant text when present.
- If no turn is in progress, pick the latest assistant message, falling back to the latest user message.
- After applying a Codex resume candidate, send:
  - the normal success message, and
  - a single "ongoing message" or "latest message" section when transcript items are available.
- Start a scope-level watcher only when a resumed thread has an in-progress turn.
- The watcher replaces any previous watcher for the same Feishu scope.
- The watcher sends a progress update only when the selected message content changes, and sends a
  final completion update when the in-progress turn finishes.

## Error Handling

Initial history read failures are logged and do not block resume. The user sees the normal resume
success message with a short note that history could not be loaded. Watcher read failures are logged
and retried until completion or timeout.

## Tests

- Unit-test the transcript parser against app-server-shaped `thread/read` payloads.
- Integration-test `/resume use` for Codex to confirm only one message is sent.
- Integration-test in-progress turn preference.
- Integration-test watcher polling until completion.
- Preserve existing audit-safe fallback behavior.
