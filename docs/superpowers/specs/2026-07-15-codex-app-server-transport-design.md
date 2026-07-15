# Codex App Server Transport Design

## Goal

Allow a Codex profile in `lark-channel-bridge` to run through `codex app-server`
instead of `codex exec`, so Lark-originated conversations are persisted as
app-server threads while the existing bridge reply UI keeps working.

## Scope

- Add a profile setting: `codex.transport`, with values `exec` and
  `app-server`.
- Keep `exec` as the default for compatibility.
- Add an app-server backed Codex run path that implements the existing
  `AgentRun` event contract.
- Enable the local `codex` profile to use `app-server` after build.

Out of scope: mirroring messages manually typed in the Codex desktop app back
to Lark. That needs a separate app-server subscription/forwarding service.

## Architecture

The existing `CodexAdapter` remains the bridge entry point. It chooses between:

- `exec`: current `codex exec --json` process mode.
- `app-server`: new `codex app-server --listen stdio://` process mode.

The app-server run path uses JSON-RPC over stdio:

1. Send `initialize` and `initialized`.
2. Start or resume a thread.
3. Start a turn with the bridge-prefixed prompt and local image inputs.
4. Translate notifications into existing `AgentEvent` values.
5. Terminate the app-server child after the turn reaches a terminal state.

## Data Flow

Lark message -> bridge prompt builder -> `CodexAdapter.run()` ->
`codex app-server` thread/turn -> app-server notifications -> bridge
`AgentEvent` stream -> Lark reply card/markdown renderer.

Thread IDs continue to be recorded in the existing session catalog, so `/resume`
keeps using the same bridge storage model.

## Error Handling

- JSON-RPC response errors become terminal bridge errors.
- app-server `error` notifications become terminal bridge errors.
- malformed or unknown notifications are ignored unless terminal state is lost.
- `stop()` sends SIGTERM and then SIGKILL after the existing grace period.

## Testing

- Unit/process tests cover app-server argv, request sequence, environment
  propagation, text/tool event translation, and default `exec` compatibility.
- Typecheck and build validate the TypeScript integration.
