# Resume Codex History Preview Design

## Goal

When a Feishu user resumes a Codex session with `/resume use <nonce>` or the resume card button,
the bridge should restore the Codex thread and send a short recent-history preview back to Feishu.

## Scope

- Codex only.
- Private chats only; group and topic chats keep the existing non-disclosing behavior.
- Show at most 10 user/assistant turns, meaning up to 20 displayed messages.
- Resume must still succeed if history preview loading fails.

## Design

- Add a Codex app-server helper that calls `thread/read` with `includeTurns: true`.
- Parse only `userMessage` and `agentMessage` items.
- Flatten text input content conservatively and skip tool, reasoning, and command items.
- Keep the newest 10 conversation turns by walking the parsed message stream from newest to oldest.
- After applying a Codex resume candidate, send:
  - the normal success message, and
  - a "recent chat history" section when transcript items are available.

## Error Handling

History read failures are logged and do not block resume. The user sees the normal resume success
message with a short note that history could not be loaded.

## Tests

- Unit-test the transcript parser against app-server-shaped `thread/read` payloads.
- Integration-test `/resume use` for Codex to confirm recent history is sent and capped.
- Preserve existing audit-safe fallback behavior.
