# Discord Plugin Defect Audit and Release Record

## Scope

This audit covers the pi-web-ui Discord plugin previously installed as `~/.pi-web/plugins/discord` (upstream v0.1.5 plus two local patch groups) and the standalone replacement in this repository.

The baseline defect evidence is preserved in the former local audit at `~/.pi-web/patches/README.md`. The standalone implementation fixes those defects at their source rather than reapplying textual patches after installation.

## Reproduced baseline defects

### 1. Assistant replies were routed to an undefined channel

**Reproduction**

1. Send a guild message that mentions the Discord bot.
2. pi-web-ui starts the agent and displays the answer in its own history.
3. Discord shows the typing indicator but receives no answer.

**Observed error**

```text
[plugin:discord] Discord reply delivery failed: Invalid Form Body
```

Discord identifies the invalid snowflake as `undefined` in `channel_id`.

**Root cause**

The old plugin invented a synthetic conversation ID (`dc_*`) and stored the pending reply under it. `host.chat` treats that value as a lookup key, falls back to a headless pseudo-client, and returns a different real conversation ID. Run events use the returned real ID. The old code discarded the dispatch result, so `run_end` found only a text-only early buffer and posted to `/channels/undefined/messages`.

**Fix**

- Keep the pending run object and re-key it to the conversation ID returned by `host.chat`.
- Buffer assistant events that arrive before the dispatch receipt and merge them after re-keying.
- Keep the host-returned client ID under validation.
- Never post a reply without a valid channel ID.
- Serialize Discord dispatches so a host conversation-ID collision cannot overwrite another pending Discord run.

**Regression coverage**

`test/discord-plugin.test.mjs` reproduces the early-event race and verifies that the reply is posted to the originating channel with the original message reference.

### 2. `/new` and `/clear` silently reused the previous conversation

**Reproduction**

1. Send a prompt that establishes useful context.
2. Send `/new` or `/clear`.
3. Ask the agent to repeat the earlier context.

**Root cause**

Changing only the synthetic `dc_*` ID did not change the host pseudo-client. The host continued using the same account ID and therefore the same existing pi session.

**Fix**

- Keep a per-user generation counter.
- Append the generation to the pseudo-client account ID (`dc_<hash>_g1`, `_g2`, …).
- Delete the remembered conversation binding on reset.
- Mark an in-flight run as cancelled when its user resets, so stale output cannot leak into the fresh generation.

**Regression coverage**

The automated tests verify that the account ID changes after `/new`, the old binding is removed, and the next prompt uses the new generation.

### 3. The working directory and model commands were incomplete

**Reproduction**

- `/cwd <path>` existed only as an informal text command and was not a native Discord command.
- `/model` only displayed the current model; it could not select or change a model.
- None of the commands appeared in Discord's native slash-command picker.

**Fix**

- Register native guild commands `/help`, `/status`, `/new`, `/clear`, `/cwd`, and `/model`.
- Make `/cwd <path>` validate and persist a per-user workspace, then start a fresh generation.
- Make `/model provider/model` validate against the host model catalog and persist the selected model.
- Add autocomplete choices for descendant directories and configured model IDs.
- Retain plain-text fallback behavior, including `/workspace` as an alias of `/cwd`.

### 4. Discord had no native interaction path

**Root cause**

The old plugin only listened for `MESSAGE_CREATE`. Discord application-command invocations arrive as `INTERACTION_CREATE` events and must be answered through the interaction callback endpoint.

**Fix**

- Handle Gateway `INTERACTION_CREATE` events.
- Answer `PING` interactions with `PONG`.
- Answer application commands with an ephemeral deferred response, then edit the original response.
- Answer autocomplete requests with interaction response type `8` and up to 25 choices.
- Register commands at guild scope through `PUT /applications/{application.id}/guilds/{guild.id}/commands` so they become available immediately.

### 5. User-facing content was not English-first

**Fix**

- Translate the dashboard, status output, errors, command help, manifest metadata, and documentation to English.
- Keep the legacy `/workspace` spelling only as a compatibility alias.

## Additional safety improvements

- Verify that `host.chat` routed the prompt to the expected `plugin:discord:<account>` pseudo-client.
- Use the stable per-user account ID for continuity instead of sending a potentially colliding in-memory conversation ID back into the host's global wake lookup.
- Apply a 10-minute run timeout and a guarded Discord reply limit.
- Restrict `/cwd` autocomplete to descendants of the current workspace.
- Keep the bot token out of plaintext storage and out of the repository.

## Automated verification

Run:

```bash
npm test
```

The release candidate must pass with zero failures. The suite covers command definitions, registration routes, Gateway intents, interaction callbacks, autocomplete, routing, persistent sessions, reset generations, workspace/model commands, allowlists, secret handling, and Markdown chunking.

## Live verification record

Live verification against Discord Application `1564275983425609788`, guild `949381557267857469`, and channel `1031955437005848616` is recorded after installation and PM2 restart.
