# pi-web-ui Discord Plugin

A standalone, English-first Discord bot plugin for [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui). It connects to Discord through an outbound Gateway WebSocket, keeps a separate multi-turn pi session for every Discord user, registers native guild slash commands, and provides autocomplete for workspace paths and model IDs.

The plugin has **no runtime npm dependencies** and uses Node's built-in `fetch`, `WebSocket`, and `node:crypto` APIs.

## Features

- Native Discord Gateway connection with no public IP or reverse proxy
- Per-user persistent pi-web-ui conversations
- Reliable reply routing back to the originating Discord channel
- Explicit `/new` and `/clear` session resets
- Native guild application commands:
  - `/help`
  - `/status`
  - `/new`
  - `/clear`
  - `/cwd [path]`
  - `/model [provider/model]`
- Discord autocomplete for `/cwd` directories and `/model` model IDs
- Backward-compatible plain-text slash commands (for example, `@Nero /help`)
- Discord user allowlist
- Encrypted bot-token storage through the pi-web-ui secrets API
- Structure-aware Markdown reply chunking
- Optional Discord message-sending AI tool
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
| New session | `/new` | `/new` | Clears the user's Discord conversation binding and starts a blank pi session. |
| Clear session | `/clear` | `/clear` | Alias of `/new`. |
| Workspace | `/cwd [path]` | `/cwd [path]`, `/workspace [path]` | Shows or changes the workspace. Changing it also starts a fresh session. |
| Model | `/model [provider/model]` | `/model [provider/model]` | Shows or changes the model used for subsequent Discord prompts. |

`/cwd` and `/model` use Discord autocomplete. Plain-text commands in a guild must mention the bot (for example, `@Nero /status`); direct messages do not require a mention.

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
| `thinkingLevel` | Optional pi thinking level. |

Per-user `/cwd` overrides are stored under the plugin's `userWorkspaces` storage key. The bot token is never written to plaintext `storage.json`.

## Session isolation and reset behavior

Each Discord user receives a stable, privacy-preserving pi-web-ui pseudo-client account ID derived from a SHA-256 hash of the Discord User ID. The account ID, rather than a globally colliding in-memory conversation ID, is used to keep the user's session on the correct headless client.

`/new`, `/clear`, and a workspace change increment a per-user generation. The generation is appended to the pseudo-client account ID, so the next prompt attaches a new headless client with a blank conversation. Replies from a superseded generation are discarded instead of leaking into the new session.

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
- `/new` and `/clear` generation resets
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
