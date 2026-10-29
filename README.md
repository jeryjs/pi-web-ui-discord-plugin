# pi-web-ui Discord Plugin

A standalone, English-first Discord bot plugin for [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui). It connects to Discord through an outbound Gateway WebSocket, keeps a separate multi-turn pi session for every Discord user, registers native guild slash commands, and provides autocomplete for workspace paths and model IDs.

The plugin has **no runtime npm dependencies** and uses Node's built-in `fetch`, `WebSocket`, and `node:crypto` APIs.

## Features

- Native Discord Gateway connection with no public IP or reverse proxy
- Per-user persistent pi-web-ui conversations
- Reliable reply routing back to the originating Discord channel
- Persistent sessions per user **and** per scope (DM and guild channel are never mixed)
- Stored session IDs that survive a pi-web-ui restart
- Explicit `/new` session reset (`/clear` is a plain-text alias of `/new`)
- Automatic replies in threads that start from a bot answer, without touching the stored configuration
- Native guild application commands:
  - `/help`
  - `/status`
  - `/new`
  - `/cwd [path]`
  - `/model [provider/model] [thinking]`
- Every slash-command answer is ephemeral: only the agent's own answer stays in the channel
- Discord autocomplete for `/cwd` directories and `/model` model IDs
- Backward-compatible plain-text slash commands (for example, `@Nero /help`)
- Discord user allowlist
- Encrypted bot-token storage through the pi-web-ui secrets API
- Structure-aware Markdown reply chunking
- Optional Discord message-sending AI tool
- Optional live tool trace (`` `think → bash → read` ``) while the agent works
- Optional live-streamed answers that are edited in place instead of posted twice
- Optional attachment support: files, images, and custom emoji are handed to the model
- English dashboard, status messages, and documentation

## Requirements

- pi-web-ui **0.112.0 or newer** with the standard `pi` engine
- Node.js **22.19.0 or newer**
- A Discord application with a bot user
- The bot token from the Discord Developer Portal

### Discord Developer Portal setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy the bot token.
3. Open **Bot → Privileged Gateway Intents** and enable **Message Content Intent**.
4. Invite the bot to a server with at least:
   - **View Channel**
   - **Send Messages**
   - **Read Message History**
5. In pi-web-ui, open the Discord dashboard, choose **Configure**, and save the token, default channel ID, and allowed user IDs.

Native guild commands are registered automatically when the Gateway receives `READY` or `GUILD_CREATE`. Guild-scoped registration is immediate and does not wait for Discord's global propagation.

## Installation

Install directly from GitHub:

```bash
pi-web-ui install jeryjs/pi-web-ui-discord-plugin --name discord --force --data-dir ~/.pi-web
```

The pi-web-ui installer preserves `storage.json`, `secrets.bin`, `config.json`, and runtime dependencies when replacing an existing plugin. Existing settings therefore survive an in-place update.

A running pi-web-ui service does **not** need to be restarted. After the CLI installation, open **Settings → UI plugins** and click **Rescan**, or refresh the browser so pi-web-ui reloads the plugin catalog. pi-web-ui 0.112.0 does not expose a separate `pi-web-ui plugins reload` subcommand; **Rescan** is the host's supported no-restart plugin reload action.

To install under a different plugin ID, omit `--name discord`. The Discord bot panel remains available under the **Discord** view.

## Commands

| Command | Native slash command | Plain-text fallback | Behavior |
| --- | --- | --- | --- |
| Help | `/help` | `/help` | Shows command help. |
| Status | `/status` | `/status` | Shows Gateway, counters, application ID, and guild command registration. |
| New session | `/new` | `/new`, `/clear` | Drops the stored session ID of the current scope; the next message starts a new pi session. `/clear` is the plain-text alias of `/new`. |
| Workspace | `/cwd [path]` | `/cwd [path]`, `/workspace [path]` | Shows or changes the workspace. Changing it also starts a fresh session. |
| Model | `/model [provider/model] [thinking]` | `/model [provider/model] [thinking]` | Shows or changes the model and the thinking level used for subsequent Discord prompts. Both parts are optional: `/model high` only changes the thinking level, `/model openai/gpt-5 max` changes both. |
| Read | `/read [count]` | `/read [count]` | Loads the last `count` messages of the current channel (default 5) into the chat context. No agent turn is triggered. |
| Context | `/context [show\|clear]` | `/context [show\|clear]` | Shows the context loaded with `/read`, or drops it with `clear`. |
| Prompt | `/pi <message> [context]` | `/pi <message>` | Sends a prompt to the pi agent through the same pipeline as an @mention. The optional `context` option sets how many recent channel messages are included (default 5). |
| Message prompt | `pi-message` (message context menu) | — | Uses the message you right-clicked as the prompt. This is the only way to hand a message to a user-installed app in a third-party DM, where channel history is not readable. |

### Loaded chat context

`/read` does not answer anything by itself: it stores the messages it fetched and confirms with a
short, dismissable (ephemeral) reply. The stored messages are then carried by **every later
prompt** — in any channel or DM — until the context is dropped with `/context clear` or the
conversation is reset with `/new` or `/cwd`. Re-reading the same channel replaces that
channel's batch instead of piling up duplicates.

Because the context belongs to the conversation, it is cleared together with it: `/new` and a `/cwd`
change both start from an empty context.

`/cwd` and `/model` use Discord autocomplete. Plain-text commands in a guild must mention the bot (for example, `@Nero /status`); direct messages do not require a mention, and channels listed under `autoReplyChannels` (plus the default channel when `autoReplyEnabled` is on) accept every message without a mention.

### Channel history in personal DMs

Discord gives an app that is installed to a **user account** no presence in third-party DMs and group chats: it can answer the interaction itself but cannot read the channel history or post channel messages there. That means:

- `/read` and the `context` option of `/pi` work in server channels and in the app's own DM.
- In a third-party DM they report that the history is unavailable, and `/pi <message>` still runs — without the transcript.
- Right-click a message → **Apps** → **pi-message** to hand that exact message to the agent. This is the only message text a user-installed app can read in such a conversation.

## Configuration

The dashboard stores these values:

| Key | Meaning |
| --- | --- |
| `botToken` | Discord bot token; stored through the encrypted pi-web-ui secrets API. |
| `botEnabled` | Starts the Gateway service when pi-web-ui activates the plugin. |
| `allowedUsers` | Discord User IDs allowed to use the bot. Empty means all users. |
| `defaultChannelId` | Default channel for dashboard and AI-tool messages. |
| `workspace` | Default workspace directory. |
| `model` | Default `provider/model` ID. |
| `thinkingLevel` | Optional pi thinking level; changed with `/model <level>`. |
| `systemPrompt` | The Discord core system prompt; changed with `/system`. |
| `systemPromptMode` | How the core prompt was last set: `replace` or `append`. |
| `autoReplyEnabled` | Answers every message in `defaultChannelId` without an @mention. |
| `autoReplyChannels` | Extra channel IDs that answer every message without an @mention. |
| `useWorkspaceSession` | Reuses the pi session open in pi-web-ui for the same workspace (default on). |
| `showToolCalls` | Adds the agent's thinking steps and tool names to the Discord answer. |
| `liveReplyEnabled` | Streams the answer into one Discord message that is edited in place. |
| `allowAttachments` | Downloads files, images, and custom emoji and shows them to the model. |
| `userSessions` | Stored session IDs per user and scope, written by the plugin itself. |

Per-user `/cwd` overrides are stored under the plugin's `userWorkspaces` storage key. The bot token is never written to plaintext `storage.json`.

## Sessions, scopes, automatic replies, and reply context

**Permanent session.** By default the bot continues the pi-web-ui conversation that is open for the
configured workspace: the plugin resolves the live conversation through the host API and passes its
conversation ID with the prompt, so Discord and the browser share one pi session instead of racing two
independent ones. When no live session matches the workspace, the bot falls back to its own stable
per-user pseudo-client session. Turn the behavior off with `useWorkspaceSession: false`.

**Stored session IDs.** Every turn that reaches pi-web-ui returns a conversation ID. The plugin writes
it into the `userSessions` configuration under the key `<scope>|<discord user id>`, so the same
conversation is continued after a pi-web-ui restart. `/new` (and its plain-text alias `/clear`)
removes that entry, and the next message starts a brand-new session whose ID is stored again.

**Scopes.** A scope is either `dm` or `guild:<guild id>:<channel id>`. Threads inherit the scope of
their parent channel. DMs and guild channels never share a session: a DM session is never continued
in a guild channel, and a guild session never leaks into a DM. `/status` shows the scope, the active
pi session ID, and the pseudo-client account of the caller.

**Ephemeral command answers.** Every slash-command answer (`/help`, `/status`, `/new`, `/cwd`,
`/model`, `/system`, `/context`, `/read`) is ephemeral, so only the person who ran the command sees
it and the channel history stays clean. The agent's own answer to a prompt stays a normal message.

**Automatic replies.** Set `autoReplyEnabled` (default channel) or list channel IDs in
`autoReplyChannels` to answer every message in those channels without an @mention. Replying to one of
the bot's own messages always reaches the bot, even outside those channels.

**Threads.** A thread that is started from one of the bot's answers answers automatically from then
on. The switch lives in memory only — the stored configuration is never changed — and it follows the
automatic-reply setting of the parent channel.

**Reply context.** When a message is a Discord reply, the referenced message is fetched (Discord only
embeds it when the bot has it cached) and passed to the agent inside a `<discord_reply_context>` block
together with the author, so "what about this?" carries the quoted message.

**Core system prompt.** `/system` manages the prompt that identifies the Discord core prompt. The
plugin API cannot change pi-web-ui's host-wide system prompt (the `{{soul}}` template section is
host-global, and pi-web-ui applies `promptOverrides` globally rather than per conversation), so the
Discord core prompt is scoped to Discord turns and stored in the same plugin configuration as
workspace, model, and thinking level. It is stated **once per conversation**: the first turn of a
conversation carries it in a `<discord_core_prompt>` block, and it then stays in the transcript
instead of being repeated in every turn. `/new` and a `/cwd` change start a new
conversation, which states it again.

Editing it mid-conversation works too: the next turn carries the new text in a
`<discord_core_prompt_update>` block that explicitly supersedes the previous one, so the change
takes effect in the running conversation instead of waiting for the next one. Because the core
prompt is one shared plugin setting, an edit applies to every Discord conversation.

Two different prompts are worth keeping apart:

| Prompt | Where it is edited | Scope |
| --- | --- | --- |
| Discord core prompt | `/system replace <text>` / `/system append <text>` in Discord | Discord turns only, shared by all Discord users |
| pi-web-ui host prompt (`{{soul}}`) | pi-web-ui settings → system prompt / prompt overrides | Every pi-web-ui session, including the browser tabs |

**Reply robustness.** A finished turn reads its answer back from the host transcript when no assistant
message event carried the text: the plugin asks the host for the conversation snapshot and, for
headless runs, for the snapshot of its own pseudo client. The real error is reported when the model
failed, so the bot no longer answers "no text output" for a turn that has an answer in the session
file.

**Turn isolation.** A shared workspace session also runs the browser tab's turns. The plugin only
collects output that belongs to the turn it dispatched: events older than the dispatch are ignored and
the text collected before the Discord turn began is dropped when that turn starts. A `run_end` that
belongs to the browser tab therefore does not end the Discord reply.


## Live tool traces, streamed replies, and attachments

**Tool trace.** With `showToolCalls` enabled the Discord answer shows what the agent did while it
worked: a `think -> bash -> read` line for every step, followed by the text that was written in that
step. The tool arguments are never sent to Discord - only the tool names are. The option also works
without streaming, so the trace is part of the final answer.

**Live streaming.** With `liveReplyEnabled` enabled the bot posts one message as soon as the agent
starts working and edits that message in place while the answer grows, so the channel shows the
progress instead of waiting for the final text. Edits are throttled to one every 1.2 seconds to stay
inside Discord's edit rate limit, and an answer longer than 2,000 characters continues in the next
message.

**Attachments.** With `allowAttachments` enabled the bot downloads the files of an inbound message
and the custom emoji it contains into `.pi-web-discord/attachments/<message-id>/` inside the
user's workspace folder, and passes their paths to the agent in a `<discord_attachments>` block. The
agent reads the files with its usual `read` tool, so images are delivered to the model natively and
text files are read as text. Downloads are limited to 10 files of 25 MB each, and folders that are
older than seven days are removed on the next download. Without the option nothing is ever fetched.

All three options are off by default and are toggled in **Settings -> Discord -> Configure**.

## Session isolation and reset behavior

Each Discord user receives a stable, privacy-preserving pi-web-ui pseudo-client account ID derived from a SHA-256 hash of the Discord User ID and the session scope. The account ID, rather than a globally colliding in-memory conversation ID, is used to keep the user's session on the correct headless client. A DM and a guild channel therefore use different accounts and different sessions.

`/new` and a workspace change increment a per-scope generation. The generation is appended to the pseudo-client account ID, so the next prompt attaches a new headless client with a blank conversation. Replies from a superseded generation are discarded instead of leaking into the new session.

Discord replies are routed using the conversation ID returned by `host.chat`, with an early-event buffer for the race where a fast model emits output before the dispatch receipt arrives. A reply without a valid channel binding is never posted to `/channels/undefined/messages`.

## Development

```bash
npm test
node --check index.mjs
node --check client/entry.mjs
```

The test suite covers:

- reply routing and early run events
- persistent multi-turn account IDs
- `/new` generation resets and scope separation between DMs and guild channels
- `/cwd` and `/model` behavior
- native command definitions and guild registration
- Discord interaction callbacks and autocomplete
- allowlist enforcement
- configuration and secret merging
- UI request/response correlation and hot-reload cleanup
- Markdown chunking

See [`AUDIT.md`](./AUDIT.md) for the defect audit and release verification record.

## License

MIT
