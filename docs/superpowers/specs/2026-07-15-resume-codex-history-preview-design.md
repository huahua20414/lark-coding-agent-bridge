# Resume Codex History Preview Design

## Goal

When a Feishu user resumes a Codex session with `/resume use <nonce>` or the resume card button,
the bridge should restore the Codex thread and send one relevant transcript message back to Feishu.

## Scope

- Codex only.
- Private chats only; group and topic chats keep the existing non-disclosing behavior.
- Show one message only.
- Prefer the message from an in-progress turn; otherwise show the latest user or assistant message.
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

## Error Handling

History read failures are logged and do not block resume. The user sees the normal resume success
message with a short note that history could not be loaded.

## Tests

- Unit-test the transcript parser against app-server-shaped `thread/read` payloads.
- Integration-test `/resume use` for Codex to confirm only one message is sent.
- Integration-test in-progress turn preference.
- Preserve existing audit-safe fallback behavior.
