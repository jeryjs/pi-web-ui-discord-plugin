/**
 * pi-web-ui Discord plugin
 *
 * A zero-dependency Discord bot bridge for pi-web-ui. It uses Discord's
 * outbound Gateway WebSocket, native guild application commands, interaction
 * callbacks, and per-user isolated pi-web-ui sessions.
 */

import { createHash } from "node:crypto";
import { mkdir as fsMkdir, readdir as fsReaddir, rm as fsRm, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_BOT_TOKEN = "discord.botToken";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const PLUGIN_VERSION = "1.6.0";

export const DISCORD_INTENTS = Object.freeze({
	GUILDS: 1 << 0,
	GUILD_MESSAGES: 1 << 9,
	DIRECT_MESSAGES: 1 << 12,
	MESSAGE_CONTENT: 1 << 15,
});

export const DISCORD_GATEWAY_INTENTS =
	DISCORD_INTENTS.GUILDS |
	DISCORD_INTENTS.GUILD_MESSAGES |
	DISCORD_INTENTS.DIRECT_MESSAGES |
	DISCORD_INTENTS.MESSAGE_CONTENT;

export const INTERACTION_TYPE = Object.freeze({
	PING: 1,
	APPLICATION_COMMAND: 2,
	MESSAGE_COMPONENT: 3,
	APPLICATION_COMMAND_AUTOCOMPLETE: 4,
	MODAL_SUBMIT: 5,
});

export const INTERACTION_CONTEXT = Object.freeze({
	GUILD: 0,
	BOT_DM: 1,
	PRIVATE_CHANNEL: 2,
});

export const INTERACTION_RESPONSE_TYPE = Object.freeze({
	PONG: 1,
	CHANNEL_MESSAGE_WITH_SOURCE: 4,
	DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
	APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
});

export const DISCORD_EPHEMERAL_FLAG = 64;
export const DISCORD_MESSAGE_LIMIT = 1950;
export const DISCORD_AUTOCOMPLETE_LIMIT = 25;

/** Default number of recent channel messages pulled in as context. */
export const DISCORD_READ_DEFAULT_COUNT = 5;
/** Upper bound for the channel history window Discord allows us to request. */
export const DISCORD_READ_MAX_COUNT = 50;

/** Native application commands registered in every guild where the bot is present. */
export const THINKING_LEVELS = Object.freeze(["off", "low", "medium", "high", "max"]);

/** Native application commands registered in every guild where the bot is present. */
export const DISCORD_COMMANDS = Object.freeze([
	Object.freeze({
		name: "help",
		description: "Show the pi-web-ui Discord bot help",
		type: 1,
	}),
	Object.freeze({
		name: "status",
		description: "Show bot status and command registration details",
		type: 1,
	}),
	Object.freeze({
		name: "new",
		description: "Start a fresh Discord conversation",
		type: 1,
	}),
	Object.freeze({
		name: "cancel",
		description: "Cancel the running Discord task",
		type: 1,
	}),
	Object.freeze({
		name: "cwd",
		description: "Show or change the Discord workspace directory",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "path",
				description: "Workspace directory (leave empty to show the current one)",
				type: 3,
				required: false,
				autocomplete: true,
			}),
		]),
	}),
	Object.freeze({
		name: "model",
		description: "Show or change the AI model and thinking level used by Discord",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "model",
				description: "Model ID in provider/model form (leave empty to show the current one)",
				type: 3,
				required: false,
				autocomplete: true,
			}),
			Object.freeze({
				name: "thinking",
				description: "Thinking level (leave empty to keep the current one)",
				type: 3,
				required: false,
				choices: THINKING_LEVELS.map((level) => Object.freeze({ name: level, value: level })),
			}),
		]),
	}),
	Object.freeze({
		name: "system",
		description: "Show or set the Discord core system prompt",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "replace",
				description: "Replace the Discord core system prompt",
				type: 3,
				required: false,
			}),
			Object.freeze({
				name: "append",
				description: "Append to the Discord core system prompt",
				type: 3,
				required: false,
			}),
		]),
	}),
	Object.freeze({
		name: "context",
		description: "Show or clear the Discord context loaded with /read",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "action",
				description: "What to do with the loaded context (default show)",
				type: 3,
				required: false,
				choices: Object.freeze([
					Object.freeze({ name: "show", value: "show" }),
					Object.freeze({ name: "clear", value: "clear" }),
				]),
			}),
		]),
	}),
	Object.freeze({
		name: "read",
		description: "Load the last messages of this channel into the chat context",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "count",
				description: `How many messages to load (1-${DISCORD_READ_MAX_COUNT}, default ${DISCORD_READ_DEFAULT_COUNT})`,
				type: 4,
				required: false,
				min_value: 1,
				max_value: DISCORD_READ_MAX_COUNT,
			}),
		]),
	}),
	Object.freeze({
		name: "pi",
		description: "Send a prompt to the pi agent",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "message",
				description: "The prompt for the pi agent",
				type: 3,
				required: true,
			}),
			Object.freeze({
				name: "context",
				description: `How many recent channel messages to include as context (1-${DISCORD_READ_MAX_COUNT}, default ${DISCORD_READ_DEFAULT_COUNT})`,
				type: 4,
				required: false,
				min_value: 1,
				max_value: DISCORD_READ_MAX_COUNT,
			}),
		]),
	}),
	Object.freeze({
		name: "pi-message",
		// Discord rejects a description on context-menu commands.
		description: "",
		type: 3,
	}),
]);

/**
 * Installation contexts supported by every native command.
 *
 * Discord defaults application commands to GUILD_INSTALL (0) only, so user-installed
 * apps need both contexts declared explicitly to expose commands in DMs.
 */
export const DISCORD_COMMAND_INTEGRATION_TYPES = Object.freeze([0, 1]);

/**
 * Interaction contexts supported by every native command.
 *
 * Discord only applies its "all contexts" default to newly created commands, so
 * commands registered without an explicit `contexts` keep `contexts: null` and
 * stay invisible outside guilds and the app's own DM. Setting `[0, 1, 2]`
 * explicitly is required for the commands to appear in DMs and GDMs with other
 * users (PRIVATE_CHANNEL) for user-installed apps.
 */
export const DISCORD_COMMAND_CONTEXTS = Object.freeze([0, 1, 2]);

/** Build the command payload sent to the Discord application command endpoints. */
export function buildCommandPayload() {
	return DISCORD_COMMANDS.map((command) => ({
		...command,
		integration_types: [...DISCORD_COMMAND_INTEGRATION_TYPES],
		contexts: [...DISCORD_COMMAND_CONTEXTS],
	}));
}

const LEGACY_COMMAND_ALIASES = Object.freeze({
	workspace: "cwd",
	// /clear does the same as /new: it drops the stored session id.
	clear: "new",
});

const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LATE_TEXT_GRACE_MS = 1_500;
/** Clock skew tolerated between the host run-event clock and the plugin clock. */
const EVENT_CLOCK_SKEW_MS = 2_000;
/** Quiet period before a shared conversation is treated as "our turn is over". */
const SHARED_RUN_SETTLE_MS = 2_500;
/** Minimum delay between Discord message edits (Discord allows ~5 edits / 5s). */
const LIVE_EDIT_MIN_INTERVAL_MS = 1_200;
/** Maximum number of attachments downloaded for a single Discord message. */
const MAX_ATTACHMENTS = 10;
/** Maximum size of a single downloaded attachment. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Downloaded attachments older than this are pruned. */
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Folder (inside the workspace) that holds the downloaded Discord attachments. */
const ATTACHMENT_DIR = ".pi-web-discord/attachments";
/** Separator between the steps of a tool trace. */
const TRACE_SEPARATOR = " → ";
/** How long the metadata of a Discord channel is cached. */
const CHANNEL_INFO_CACHE_MS = 60_000;
/** How many of the bot's own message ids are remembered for thread detection. */
const BOT_MESSAGE_MEMORY = 200;
const MODEL_CACHE_MS = 30_000;
const AUTOCOMPLETE_TIMEOUT_MS = 2_000;

/** Strip pi-web-ui internal inline markers from assistant output. */
export function stripInternalMarkers(text) {
	const marker = "\uE000";
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, marker)
		.replace(/[ \t]*\uE000[ \t]*/g, (match) => (/[ \t]/.test(match) ? " " : ""))
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generate a stable, privacy-preserving account ID for a Discord user. */
export function peerAccountId(userId, prefix = "dc") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/**
 * The scope of a Discord conversation.
 *
 * A DM and a guild channel are separate scopes: the bot never mixes a
 * private DM conversation into a channel conversation.
 */
export function sessionScope({ guildId = "", channelId = "" } = {}) {
	const guild = String(guildId || "").trim();
	if (!guild) return "dm";
	const channel = String(channelId || "").trim();
	return channel ? `guild:${guild}:${channel}` : `guild:${guild}`;
}

/** The key that binds one Discord user to one session scope. */
export function sessionKey(scope, authorId) {
	return `${scope || "dm"}|${String(authorId || "").trim()}`;
}

/**
 * Split the arguments of `/model` into a model and a thinking level.
 *
 * Both parts are optional. A model is written as `provider/model`; a bare
 * word is treated as the thinking level, so `/model high` works.
 */
export function parseModelArguments(input) {
	const text = String(input ?? "").trim();
	const result = { model: "", thinking: "", thinkingReset: false, invalid: "" };
	if (!text) return result;
	for (const part of text.split(/[\s,]+/).filter(Boolean)) {
		if (part.includes("/")) {
			result.model = part;
			continue;
		}
		const lower = part.toLowerCase();
		if (["default", "host", "none", "reset"].includes(lower)) {
			result.thinking = "";
			result.thinkingReset = true;
			continue;
		}
		if (THINKING_LEVELS.includes(lower)) {
			result.thinking = lower;
			continue;
		}
		result.invalid = part;
	}
	return result;
}

/** Extract message text and remove a direct bot mention from it. */
export function extractDiscordText(message, botId = "") {
	let text = String(message?.content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`\\s*<@!?${botId}>\\s*`, "g");
		text = text.replace(regex, " ").trim();
	}
	return text;
}

/** Parse a legacy plain-text slash command. */
export function parseLegacyCommand(text) {
	const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(String(text ?? "").trim());
	if (!match) return null;
	const rawName = match[1].toLowerCase();
	return {
		name: LEGACY_COMMAND_ALIASES[rawName] || rawName,
		rawName,
		args: String(match[2] ?? "").trim(),
	};
}

/**
 * Default Discord core system prompt.
 *
 * The plugin API cannot change pi-web-ui's host-wide system prompt, so Discord
 * runs get their own core prompt. It is stated once at the start of a
 * conversation and then lives in the transcript.
 */
export const DEFAULT_CORE_PROMPT = [
	"You are Nero, the pi-web-ui coding agent assistant connected to Discord.",
	"Answer with concise, actionable results and reference concrete file paths.",
].join(" ");

/** Normalize a thinking level; an empty result means "follow the host default". */
export function normalizeThinkingLevel(value) {
	const text = String(value ?? "").trim().toLowerCase();
	if (!text) return "";
	if (["default", "host", "none", "reset"].includes(text)) return "";
	return THINKING_LEVELS.includes(text) ? text : "";
}

/** Normalize the list of channels where every message reaches the bot. */
export function normalizeAutoReplyChannels(value) {
	const values = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
	return [...new Set(values.map((entry) => String(entry).trim()).filter(Boolean))];
}

/** Channels where the bot answers every message without an @mention. */
export function autoReplyChannels(config) {
	const channels = normalizeAutoReplyChannels(config?.autoReplyChannels);
	if (config?.autoReplyEnabled) {
		const fallback = String(config?.defaultChannelId || "").trim();
		if (fallback && !channels.includes(fallback)) channels.unshift(fallback);
	}
	return channels;
}

/** Whether a channel is configured for automatic replies. */
export function isAutoReplyChannel(channelId, config) {
	const id = String(channelId || "").trim();
	if (!id) return false;
	return autoReplyChannels(config).includes(id);
}

/** The effective Discord core system prompt. */
export function buildCorePrompt(config) {
	const stored = String(config?.systemPrompt || "").trim();
	return stored || DEFAULT_CORE_PROMPT;
}

/** Append text to the current core system prompt. */
export function appendCorePrompt(config, text) {
	const addition = String(text || "").trim();
	const current = buildCorePrompt(config);
	if (!addition) return current;
	return current ? `${current}\n\n${addition}` : addition;
}

/**
 * Wrap the routed message with the Discord core prompt and optional context.
 *
 * The core prompt is a conversation-level instruction: it is stated once when
 * the conversation starts and then lives in the transcript, instead of being
 * repeated in every turn. When it is edited mid-conversation, the new text is
 * stated once and explicitly supersedes the previous one, so an edit takes
 * effect in the running conversation instead of waiting for the next one.
 * The loaded context (from `/read`) is carried by every turn until it is cleared.
 */
export function buildRequestText({
	text = "",
	config = {},
	replyContext = "",
	loadedContext = "",
	attachments = "",
	includeCorePrompt = true,
	corePrompt = null,
} = {}) {
	const body = String(text || "").trim();
	const parts = [];
	const mode = corePrompt?.mode || (includeCorePrompt ? "state" : "none");
	const prompt = String(corePrompt?.prompt || buildCorePrompt(config) || "").trim();
	if (prompt && mode === "state") {
		parts.push("<discord_core_prompt>", prompt, "</discord_core_prompt>");
	}
	if (prompt && mode === "update") {
		parts.push(
			"<discord_core_prompt_update>",
			"The Discord core prompt has changed. It now reads:",
			prompt,
			"This replaces the earlier core prompt.",
			"</discord_core_prompt_update>",
		);
	}
	const context = String(replyContext || "").trim();
	if (context) {
		parts.push("<discord_reply_context>", context, "</discord_reply_context>");
	}
	const loaded = String(loadedContext || "").trim();
	if (loaded) {
		parts.push("<discord_context>", loaded, "</discord_context>");
	}
	const files = String(attachments || "").trim();
	if (files) {
		parts.push(files);
	}
	parts.push("<discord_user_message>", body, "</discord_user_message>");
	return parts.join("\n");
}

/** Parse the mutually exclusive `replace` / `append` options of `/system`. */
export function parseSystemArguments({ replace = "", append = "" } = {}) {
	const replaceText = String(replace ?? "").trim();
	const appendText = String(append ?? "").trim();
	if (replaceText && appendText) {
		return { error: "The `replace` and `append` options are mutually exclusive — use only one." };
	}
	if (replaceText) return { mode: "replace", text: replaceText };
	if (appendText) return { mode: "append", text: appendText };
	return { mode: "", text: "" };
}

/** Parse the plain-text form of `/system replace <text>` / `/system append <text>`. */
export function parseSystemCommandArgument(argument) {
	const text = String(argument ?? "").trim();
	if (!text) return { replace: "", append: "" };
	const match = /^(replace|append)\s+([\s\S]*)$/i.exec(text);
	if (!match) return { replace: "", append: "", invalid: text };
	if (match[1].toLowerCase() === "replace") return { replace: match[2].trim(), append: "" };
	return { replace: "", append: match[2].trim() };
}

/** Whether the message explicitly mentions the bot. */
export function isBotMentioned(message, botId) {
	const id = String(botId || "").trim();
	if (!id) return false;
	const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
	return mentions.some((user) => String(user?.id || "") === id);
}

/** Whether the message replies to a message written by the bot. */
export function isReplyToBotMessage(message, botId, referencedMessage = null) {
	const id = String(botId || "").trim();
	if (!id) return false;
	const reference = referencedMessage || message?.referenced_message || null;
	const authorId = String(reference?.author?.id || "").trim();
	return Boolean(authorId) && authorId === id;
}

/**
 * Whether an inbound guild message is addressed to the bot.
 *
 * A message qualifies when it mentions the bot, replies to the bot, or is sent
 * in a channel configured for automatic replies.
 */
export function isMessageAddressedToBot(
	message,
	{ botId = "", config = {}, referencedMessage = null, autoReplyThreadIds = null } = {},
) {
	if (isBotMentioned(message, botId)) return true;
	if (isReplyToBotMessage(message, botId, referencedMessage)) return true;
	if (isAutoReplyChannel(message?.channel_id, config)) return true;
	// A thread that was started from a reply of the bot answers automatically,
	// but only while the default channel automatic replies are switched on.
	const channelId = String(message?.channel_id || "");
	if (config?.autoReplyEnabled && channelId && autoReplyThreadIds?.has?.(channelId)) return true;
	return false;
}

/** Build the context block for a replied-to Discord message. */
export function buildReplyContext(referencedMessage, { botId = "", limit = 1500 } = {}) {
	if (!referencedMessage) return "";
	const author = referencedMessage?.author || {};
	const authorId = String(author?.id || "").trim();
	const isBot = Boolean(author?.bot) || (botId && authorId === String(botId));
	const displayName = String(author?.global_name || author?.username || "").trim();
	const who = isBot ? "the bot" : displayName ? `@${displayName}` : authorId ? `user ${authorId}` : "another user";
	const suffix = !isBot && authorId ? ` (${authorId})` : "";
	const content = String(referencedMessage?.content || "").trim();
	const body = content ? content.slice(0, limit) : "(the referenced message has no text content)";
	return `Replying to ${who}${suffix}:\n${body}`;
}

/**
 * Clamp a requested channel-history count.
 *
 * A zero result means "do not attach any context".
 */
export function normalizeReadCount(value, fallback = DISCORD_READ_DEFAULT_COUNT) {
	const text = String(value ?? "").trim();
	if (!text) return fallback;
	const raw = Number(text);
	if (!Number.isFinite(raw)) return fallback;
	const count = Math.floor(raw);
	if (count <= 0) return 0;
	return Math.min(count, DISCORD_READ_MAX_COUNT);
}

/**
 * Format recent channel messages into a context block for the agent.
 *
 * Discord returns messages newest-first; the block is rendered oldest-first so
 * the agent reads the conversation in chronological order.
 */
export function formatChannelContext(messages, { botId = "", messageLimit = 1000 } = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const rows = [];
	for (const message of [...list].reverse()) {
		const content = String(message?.content || "").trim();
		if (!content) continue;
		const author = message?.author || {};
		const authorId = String(author?.id || "").trim();
		const isBot = Boolean(author?.bot) || (botId && authorId === String(botId));
		const name = String(author?.global_name || author?.username || "").trim();
		const who = isBot ? "the bot" : name ? `@${name}` : authorId ? `user ${authorId}` : "someone";
		const body = content.length > messageLimit ? `${content.slice(0, messageLimit)}…` : content;
		rows.push(`${who}: ${body}`);
	}
	if (!rows.length) return "";
	return ["Recent messages in this Discord channel:", ...rows.map((row) => `- ${row}`)].join("\n");
}

/**
 * Render recent channel messages as a readable transcript.
 */
export function formatChannelTranscript(messages, { botId = "", messageLimit = 500 } = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const rows = [];
	for (const message of [...list].reverse()) {
		const author = message?.author || {};
		const authorId = String(author?.id || "").trim();
		const isBot = Boolean(author?.bot) || (botId && authorId === String(botId));
		const name = String(author?.global_name || author?.username || authorId || "someone").trim();
		const content = String(message?.content || "").trim();
		const body = content ? (content.length > messageLimit ? `${content.slice(0, messageLimit)}…` : content) : "(no text content)";
		const stamp = String(message?.timestamp || "").trim();
		const when = stamp ? stamp.replace("T", " ").replace(/\.\d+(?:\+00:00|Z)$/, " UTC") : "";
		rows.push(`- ${isBot ? "the bot" : `@${name}`}${when ? ` · ${when}` : ""}: ${body}`);
	}
	return rows;
}

/** Normalize a Discord message into a storable context entry. */
export function normalizeLoadedMessage(message, botId = "") {
	const author = message?.author || {};
	const authorId = String(author?.id || "").trim();
	return {
		authorId,
		authorName: String(author?.global_name || author?.username || "").trim(),
		isBot: Boolean(author?.bot) || (botId && authorId === String(botId)),
		content: String(message?.content || "").trim(),
		timestamp: String(message?.timestamp || "").trim(),
	};
}

/**
 * Format the batches loaded with `/read` into a context block.
 *
 * Each batch is one channel read earlier; the block is rendered oldest-first
 * so the agent reads the conversations in the order they were loaded.
 */
export function formatLoadedContext(batches, { botId = "", messageLimit = 1000 } = {}) {
	const list = Array.isArray(batches) ? batches : [];
	const blocks = [];
	for (const batch of list) {
		const messages = Array.isArray(batch?.messages) ? batch.messages : [];
		if (!messages.length) continue;
		const where = String(batch?.channelName || batch?.channelId || "a Discord channel").trim();
		const rows = [];
		for (const message of messages) {
			const content = String(message?.content || "").trim();
			if (!content) continue;
			const authorId = String(message?.authorId || "").trim();
			const isBot = Boolean(message?.isBot) || (botId && authorId === String(botId));
			const name = String(message?.authorName || "").trim();
			const who = isBot ? "the bot" : name ? `@${name}` : authorId ? `user ${authorId}` : "someone";
			const body = content.length > messageLimit ? `${content.slice(0, messageLimit)}…` : content;
			rows.push(`${who}: ${body}`);
		}
		if (!rows.length) continue;
		blocks.push([`Messages loaded from ${where}:`, ...rows.map((row) => `- ${row}`)].join("\n"));
	}
	if (!blocks.length) return "";
	return ["Context loaded from Discord with /read:", ...blocks.map((block) => `\n${block}`)].join("\n");
}

/** Extract the newest assistant text from a conversation snapshot. */
export function extractLastAssistantText(conversation, { since = 0 } = {}) {
	const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
	let lastUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (String(messages[index]?.role || "") === "user") {
			lastUserIndex = index;
			break;
		}
	}
	for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
		const message = messages[index];
		if (String(message?.role || "") !== "assistant") continue;
		const timestamp = Number(message?.timestamp || 0);
		if (since && timestamp >= 1e12 && timestamp < since) continue;
		const text = extractAssistantContent(message);
		if (text) return text;
	}
	return "";
}

/**
 * Extract the activity of one assistant message.
 *
 * Only the kind of activity matters for the Discord trace: thinking blocks,
 * tool calls (by name) and the text the model produced.
 */
export function extractAssistantActivity(message) {
	const content = Array.isArray(message?.content) ? message.content : [];
	const activity = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "thinking") {
			activity.push({ think: true });
		} else if (part.type === "toolCall") {
			activity.push({ tool: String(part.name || "tool") });
		} else if (part.type === "text") {
			const text = String(part.text || "");
			if (text) activity.push({ text });
		}
	}
	return activity;
}

/**
 * Append one assistant activity to the trace of a run.
 *
 * The trace mirrors what the user watches while the agent works: a line of
 * `think -> tool -> tool` steps, followed by the text produced in that step.
 * A step that starts after text was written opens a new segment.
 */
export function appendRunActivity(run, activity) {
	if (!run) return null;
	if (!Array.isArray(run.segments)) run.segments = [];
	if (!run.segments.length) run.segments.push({ trace: [], text: "" });
	let segment = run.segments[run.segments.length - 1];
	const think = Boolean(activity?.think);
	const tool = String(activity?.tool || "").trim();
	const text = typeof activity?.text === "string" ? activity.text : "";
	if ((think || tool) && String(segment.text || "").trim()) {
		segment = { trace: [], text: "" };
		run.segments.push(segment);
	}
	if (think && segment.trace[segment.trace.length - 1] !== "think") segment.trace.push("think");
	if (tool) segment.trace.push(tool);
	if (text) segment.text += text;
	return segment;
}

/** Render the live view of a run: one trace line plus its text per segment. */
export function renderRunContent(run, { showTrace = true } = {}) {
	const segments = Array.isArray(run?.segments) ? run.segments : [];
	if (!showTrace) {
		return segments
			.map((segment) => String(segment?.text || "").trim())
			.filter(Boolean)
			.join("\n");
	}
	const blocks = [];
	for (const segment of segments) {
		const trace = (Array.isArray(segment?.trace) ? segment.trace : []).join(TRACE_SEPARATOR);
		const text = String(segment?.text || "").trim();
		if (!trace && !text) continue;
		// The trace is shown as inline code so the steps read as one unit.
		blocks.push(trace ? (text ? `\`${trace}\`\n${text}` : `\`${trace}\``) : text);
	}
	return blocks.join("\n");
}

/** Pick the split point that keeps a live Discord page below the limit. */
export function findLiveCut(text, limit = DISCORD_MESSAGE_LIMIT) {
	const body = String(text || "");
	if (body.length <= limit) return body.length;
	const newline = body.lastIndexOf("\n", limit);
	return newline > limit * 0.5 ? newline : limit;
}

/** Whether an attachment type is safe to download and hand to the agent. */
export function isSupportedAttachmentType(contentType, filename = "") {
	const type = String(contentType || "").toLowerCase().split(";")[0].trim();
	if (type.startsWith("image/")) return type !== "image/svg+xml";
	if (type.startsWith("text/")) return true;
	if (["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml", "application/toml", "application/sql"].includes(type)) return true;
	const extension = String(filename || "").toLowerCase().split(".").pop() || "";
	return ["txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "csv", "tsv", "log", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "sh", "bash", "zsh", "sql", "html", "css", "xml"].includes(extension);
}

/** Build a safe file name for a downloaded attachment. */
export function safeAttachmentName(filename, fallback = "attachment") {
	const base = String(filename || "")
		.split(/[\\/]/)
		.pop()
		.replace(/[^\w.\- ]+/g, "_")
		.trim()
		.slice(0, 80);
	return base || fallback;
}

/**
 * Collect the attachments of an inbound Discord message.
 *
 * Files arrive as attachments; custom emoji are fetched from the CDN.
 */
export function collectMessageAttachments(message) {
	const items = [];
	const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
	for (const attachment of attachments) {
		const url = String(attachment?.url || "").trim();
		if (!url) continue;
		items.push({
			url,
			size: Number(attachment?.size || 0),
			contentType: String(attachment?.content_type || "").trim(),
			filename: String(attachment?.filename || "attachment").trim(),
			kind: "file",
		});
	}
	const content = String(message?.content || "");
	const emojiPattern = /<a?:([a-zA-Z0-9_]+):(\d{15,})>/g;
	for (const match of content.matchAll(emojiPattern)) {
		const [, name, id] = match;
		const animated = content.includes(`<a:${name}:${id}>`);
		items.push({
			url: `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`,
			size: 0,
			contentType: animated ? "image/gif" : "image/png",
			filename: `emoji-${name}.${animated ? "gif" : "png"}`,
			kind: "emoji",
		});
	}
	return items.slice(0, MAX_ATTACHMENTS);
}

/** Describe the downloaded attachments for the agent prompt. */
export function buildAttachmentContext(downloaded = [], skipped = []) {
	if (!downloaded.length && !skipped.length) return "";
	const lines = [];
	if (downloaded.length) {
		lines.push("The user sent these files with the message. Read them with the read tool - images are delivered to you natively.");
		for (const [index, item] of downloaded.entries()) {
			const type = item.contentType ? ` (${item.contentType})` : "";
			lines.push(`${index + 1}. ${item.kind === "emoji" ? "emoji" : "file"} "${item.filename}"${type} -> ${item.path}`);
		}
	}
	if (skipped.length) {
		const names = skipped.map((item) => `"${item.filename}"`).join(", ");
		lines.push(`Not downloaded (unsupported type or too large): ${names}`);
	}
	return ["<discord_attachments>", ...lines, "</discord_attachments>"].join("\n");
}
/** Normalize the configured Discord user allowlist. */
export function normalizeAllowedUsers(value) {
	const values = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
	return [...new Set(values.map((entry) => String(entry).trim()).filter(Boolean))];
}

/** Whether a Discord user may use the bot. An empty allowlist allows everyone. */
export function isAllowedUser(config, userId) {
	const allowed = normalizeAllowedUsers(config?.allowedUsers);
	return allowed.length === 0 || allowed.includes(String(userId ?? ""));
}

/** Remove secrets from configuration before writing it to plaintext storage. */
export function stripSecretsFromConfig(config) {
	const result = { ...(config || {}) };
	delete result.botToken;
	delete result.hasBotToken;
	return result;
}

/** Merge an incoming configuration with the previously encrypted bot token. */
export function mergeSavedSecrets(incoming, previous = {}, savedSecrets = {}) {
	const output = { ...(previous || {}), ...(incoming || {}) };
	const existingBotToken = savedSecrets[SECRET_BOT_TOKEN] || previous.botToken || "";

	if (incoming.clearBotToken) {
		output.botToken = "";
	} else if (typeof incoming.botToken === "string" && incoming.botToken.trim()) {
		output.botToken = incoming.botToken.trim();
	} else {
		output.botToken = existingBotToken;
	}

	delete output.clearBotToken;
	return output;
}

/** Discord REST API helper. */
export async function discordApi(token, method, path, payload = null, { timeoutMs = 15_000 } = {}) {
	if (!token) throw new Error("Discord Bot Token is required.");
	const url = `${DISCORD_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
	const headers = {
		Authorization: `Bot ${token}`,
		"User-Agent": `DiscordBot (pi-web-ui-discord-plugin, ${PLUGIN_VERSION})`,
	};
	if (payload !== null) headers["Content-Type"] = "application/json; charset=utf-8";

	const response = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		const error = new Error(body.message || `Discord HTTP ${response.status}`);
		error.status = response.status;
		error.code = body.code;
		throw error;
	}
	if (response.status === 204) return null;
	return await response.json();
}

function truncateDiscordValue(value, limit = 100) {
	const text = String(value ?? "");
	return text.length <= limit ? text : text.slice(0, limit);
}

function isPathInside(root, candidate) {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Build directory choices for `/cwd` autocomplete.
 *
 * Suggestions are limited to descendants of the current workspace. Users may
 * still type an absolute path manually when a host allows a different root.
 */
export async function buildDirectoryChoices(root, input = "", { fsImpl, limit = DISCORD_AUTOCOMPLETE_LIMIT } = {}) {
	const fs = fsImpl || { readdir: fsReaddir, stat: fsStat };
	const rootPath = resolve(String(root || process.cwd()));
	const typed = String(input || "").trim();
	let basePath = rootPath;
	let displayPrefix = "";
	let query = "";

	if (typed) {
		if (isAbsolute(typed)) {
			const endsWithSeparator = /[\\/]$/.test(typed);
			basePath = endsWithSeparator ? typed : dirname(typed);
			query = endsWithSeparator ? "" : typed.split(/[\\/]/).pop() || "";
		} else {
			const slash = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\"));
			if (slash >= 0) {
				const directory = typed.slice(0, slash);
				basePath = resolve(rootPath, directory || ".");
				displayPrefix = `${directory.replace(/[\\/]+$/, "")}/`;
				query = typed.slice(slash + 1);
			} else {
				query = typed;
			}
		}
	}

	basePath = resolve(basePath);
	if (!isPathInside(rootPath, basePath)) return [];

	let entries;
	try {
		entries = await fs.readdir(basePath, { withFileTypes: true });
	} catch {
		return [];
	}

	const choices = [];
	const loweredQuery = query.toLowerCase();
	for (const entry of entries) {
		if (!entry?.isDirectory?.()) continue;
		if (loweredQuery && !entry.name.toLowerCase().includes(loweredQuery)) continue;
		const value = resolve(basePath, entry.name);
		if (!isPathInside(rootPath, value) || value.length > 100) continue;
		choices.push({
			name: truncateDiscordValue(`${displayPrefix}${entry.name}`),
			value,
		});
	}

	choices.sort((a, b) => a.name.localeCompare(b.name));
	return choices.slice(0, limit);
}

function normalizeModelCatalog(models) {
	const ids = new Set();
	for (const model of Array.isArray(models) ? models : []) {
		const id = String(model?.id ?? "").trim();
		if (!id) continue;
		ids.add(id);
	}
	return [...ids].sort((a, b) => a.localeCompare(b));
}

function modelChoices(catalog, query = "", limit = DISCORD_AUTOCOMPLETE_LIMIT) {
	const lowered = String(query || "").trim().toLowerCase();
	return catalog
		.filter((id) => !lowered || id.toLowerCase().includes(lowered))
		.slice(0, limit)
		.map((id) => ({ name: truncateDiscordValue(id), value: truncateDiscordValue(id) }));
}

function interactionOption(interaction, name) {
	const options = Array.isArray(interaction?.data?.options) ? interaction.data.options : [];
	const option = options.find((entry) => entry?.name === name);
	return String(option?.value ?? "").trim();
}

function extractAssistantContent(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.map((part) => (typeof part === "string" ? part : part?.text || ""))
		.join("\n")
		.trim();
}

function withTimeout(promise, timeoutMs, fallback) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), timeoutMs);
		timer.unref?.();
	});
	return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Discord Gateway bridge and pi-web-ui session router.
 */
export class DiscordBotBridge {
	constructor({
		host,
		getConfig,
		updateConfig,
		persistUserWorkspaces,
		initialUserWorkspaces,
		persistUserContexts,
		initialUserContexts,
		log,
		api,
		fsImpl,
		webSocketFactory,
	} = {}) {
		this.host = host;
		this.getConfig = getConfig || (() => ({}));
		this.updateConfig = updateConfig || (async () => {});
		this.persistUserWorkspaces = persistUserWorkspaces || (async () => {});
		this.persistUserContexts = persistUserContexts || (async () => {});
		this.log = log || ((level, message) => console.log(`[discord-bot:${level}] ${message}`));
		this.api = api || discordApi;
		this.fs = fsImpl || { readdir: fsReaddir, stat: fsStat, mkdir: fsMkdir, writeFile: fsWriteFile, rm: fsRm };
		this.webSocketFactory =
			webSocketFactory || ((url) => new globalThis.WebSocket(url));

		this.running = false;
		this.ws = null;
		this.heartbeatTimer = null;
		this.reconnectTimer = null;
		this.lastSequence = null;
		this.botUser = null;
		this.applicationId = "";
		this.offRunEvent = null;

		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.runErrors = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map(Object.entries(initialUserWorkspaces || {}));
		this.userContexts = new Map(Object.entries(initialUserContexts || {}));
		this.userSessions = new Map(Object.entries(this.getConfig()?.userSessions || {}));
		this.corePromptStates = new Map();
		this.userGenerations = new Map();
		this.autoReplyThreadIds = new Set();
		this.botMessageIds = new Set();
		this.channelInfoCache = new Map();
		this.knownGuilds = new Set();
		this.registeredGuilds = new Set();
		this.registeredGlobally = false;
		this.commandRegistrations = new Map();
		this.modelCatalog = [];
		this.modelCatalogAt = 0;
		this.activeDispatch = null;
		this.dispatchTail = Promise.resolve();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			botUsername: "",
			botUserId: "",
			applicationId: "",
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
			registeredGuilds: [],
			registeredCommands: DISCORD_COMMANDS.length,
			registeredGlobally: false,
		};
	}

	getStatus() {
		return {
			...this.status,
			registeredGuilds: [...this.registeredGuilds].sort(),
			knownGuilds: [...this.knownGuilds].sort(),
			activeRuns: this.pendingRuns.size,
			storedSessions: this.userSessions.size,
		};
	}

	/** The batches loaded with `/read` for one user, oldest load first. */
	loadedBatches(authorId, { excludeChannelId = "" } = {}) {
		const store = this.userContexts.get(authorId) || {};
		return Object.entries(store)
			.filter(([channelId]) => channelId !== excludeChannelId)
			.map(([channelId, batch]) => ({ channelId, ...(batch || {}) }))
			.sort((a, b) => Number(a.loadedAt || 0) - Number(b.loadedAt || 0));
	}

	/** The plain object persisted in the plugin storage. */
	serializedUserContexts() {
		return Object.fromEntries(this.userContexts.entries());
	}

	/**
	 * Store the messages of one channel as the user's loaded context.
	 *
	 * Re-reading the same channel replaces its batch, so the context never
	 * grows with repeated `/read` calls in the same place.
	 */
	async loadChannelContext(authorId, channelId, channelName, messages) {
		const store = { ...(this.userContexts.get(authorId) || {}) };
		store[channelId] = {
			channelId,
			channelName: String(channelName || channelId || "").trim(),
			loadedAt: Date.now(),
			messages: (Array.isArray(messages) ? messages : []).filter((message) => message?.content),
		};
		this.userContexts.set(authorId, store);
		await this.persistUserContexts(this.serializedUserContexts());
		return store[channelId];
	}

	/** Drop the loaded context of one user. */
	async clearUserContext(authorId) {
		this.userContexts.delete(authorId);
		await this.persistUserContexts(this.serializedUserContexts());
	}

	/**
	 * Decide what the Discord core prompt needs this turn.
	 *
	 * - "state": a new conversation, so the prompt is stated in full.
	 * - "update": the prompt was edited mid-conversation, so the new text is
	 *   stated once and explicitly supersedes the previous one.
	 * - "none": nothing to say, it already lives in the transcript.
	 */
	corePromptInjection(authorId, config = this.getConfig()) {
		const prompt = buildCorePrompt(config);
		if (!prompt) return { mode: "none", prompt: "" };
		const generation = Number(this.userGenerations.get(authorId) || 0);
		const state = this.corePromptStates.get(authorId);
		if (!state || state.generation !== generation) {
			this.corePromptStates.set(authorId, { generation, prompt });
			return { mode: "state", prompt };
		}
		if (state.prompt !== prompt) {
			this.corePromptStates.set(authorId, { generation, prompt });
			return { mode: "update", prompt };
		}
		return { mode: "none", prompt: "" };
	}

	async resolveWorkspace(authorId, config = this.getConfig()) {
		const existing = String(this.userWorkspaces.get(authorId) || "").trim();
		if (existing) return existing;
		const base = String(config?.workspace || this.host?.cwd || "").trim();
		if (!base) return "";
		const workspace = resolve(base, String(authorId));
		await this.ensureWorkspaceDirectory(workspace);
		this.userWorkspaces.set(authorId, workspace);
		await this.persistUserWorkspaces(Object.fromEntries(this.userWorkspaces));
		return workspace;
	}

	/** Create the workspace directory for a user if it does not exist yet. */
	async ensureWorkspaceDirectory(workspace) {
		try {
			await this.fs.mkdir(workspace, { recursive: true });
		} catch (error) {
			this.log("warn", `Failed to create workspace directory ${workspace}: ${error?.message || error}`);
		}
	}

	/** Stable account ID for one session scope; the generation changes after a reset. */
	userAccountId(key) {
		const generation = Number(this.userGenerations.get(key) || 0);
		const base = peerAccountId(key);
		return generation > 0 ? `${base}_g${generation}` : base;
	}

	/**
	 * Drop the remembered conversation of one scope and force the next prompt
	 * onto a blank pseudo client.
	 *
	 * The stored session id is removed as well, so the next turn starts a new
	 * session and writes the new id back to the configuration.
	 */
	async resetUserConversation(key, { authorId = "" } = {}) {
		const generation = Number(this.userGenerations.get(key) || 0) + 1;
		this.userGenerations.set(key, generation);
		this.userConversations.delete(key);
		this.userSessions.delete(key);
		await this.persistUserSessions();
		// A fresh conversation starts without the context loaded with /read.
		if (authorId) {
			this.userContexts.delete(authorId);
			void this.persistUserContexts(this.serializedUserContexts());
		}
		for (const run of this.pendingRuns.values()) {
			if (run.authorId === authorId) run.cancelled = true;
		}
		return this.userAccountId(key);
	}

	/** Remember the session of a scope so it can be reused after a restart. */
	async rememberUserSession(key, conversationId) {
		const id = String(conversationId || "").trim();
		if (!id) return;
		this.userConversations.set(key, id);
		this.userSessions.set(key, { conversationId: id, updatedAt: Date.now() });
		await this.persistUserSessions();
	}

	/** Write the remembered sessions into the plugin configuration. */
	async persistUserSessions() {
		const sessions = Object.fromEntries(this.userSessions);
		try {
			await this.updateConfig({ userSessions: sessions });
		} catch (error) {
			this.log("warn", `Failed to persist the Discord session records: ${error?.message || error}`);
		}
	}

	/**
	 * The session a scope should continue.
	 *
	 * The session open in pi-web-ui is shared, so it is only used for guild
	 * channels: a DM never lands in a channel conversation, and a channel
	 * conversation never continues a DM. Without a shared session the scope
	 * keeps its own session, which survives restarts through the config.
	 */
	async resolveSessionTarget({ key = "", scope = "dm", authorId = "", config = this.getConfig() } = {}) {
		if (config?.useWorkspaceSession !== false && String(scope || "").startsWith("guild:")) {
			const shared = await this.resolveWorkspaceConversation(authorId, config);
			if (shared) return shared;
		}
		return String(this.userSessions.get(key)?.conversationId || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		if (!this.getConfig().botToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Discord Bot Token";
			return;
		}

		if (this.host?.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((event) => this.handleRunEvent(event));
		}

		try {
			await this.connectGateway();
			void this.refreshModelCatalog();
		} catch (error) {
			this.status.state = "error";
			this.status.lastError = error?.message || String(error);
			this.log("warn", `Discord start error: ${this.status.lastError}`);
		}
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
			this.ws = null;
		}
		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async connectGateway() {
		const config = this.getConfig();
		if (!config.botToken) return;

		let gatewayUrl = "wss://gateway.discord.gg/?v=10&encoding=json";
		try {
			const gateway = await this.api(config.botToken, "GET", "/gateway/bot", null, { timeoutMs: 10_000 });
			if (gateway?.url) gatewayUrl = `${gateway.url}/?v=10&encoding=json`;
		} catch (error) {
			this.log("info", `Using the default Discord Gateway URL: ${error?.message || error}`);
		}

		if (typeof this.webSocketFactory !== "function") {
			throw new Error("No Discord Gateway WebSocket implementation is available.");
		}

		const ws = this.webSocketFactory(gatewayUrl);
		this.ws = ws;
		ws.onopen = () => this.log("info", "Discord Gateway WebSocket opened");
		ws.onmessage = (event) => this.handleGatewayPayload(event.data);
		ws.onerror = (error) => {
			this.status.lastError = error?.message || "Discord Gateway error";
			this.log("warn", `Discord Gateway error: ${this.status.lastError}`);
		};
		ws.onclose = (closeEvent) => {
			const closeCode = Number(closeEvent?.code ?? 0);
			const closeReason = String(closeEvent?.reason || "").trim();
			this.status.connected = false;
			this.log(
				"warn",
				`Discord Gateway closed (code=${closeCode}${closeReason ? `, reason=${closeReason}` : ""})`,
			);
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			if (this.running) {
				this.status.state = "connecting";
				if (!this.reconnectTimer) {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						if (this.running) void this.connectGateway().catch(() => {});
					}, 5_000);
					this.reconnectTimer.unref?.();
				}
			} else {
				this.status.state = "idle";
			}
		};
	}

	handleGatewayPayload(dataRaw) {
		let packet;
		try {
			const text = typeof dataRaw === "string" ? dataRaw : new TextDecoder().decode(dataRaw);
			packet = JSON.parse(text);
		} catch {
			return;
		}

		const { op, d, s, t } = packet;
		if (typeof s === "number") this.lastSequence = s;

		if (op === 10) {
			const interval = Number(d?.heartbeat_interval) || 41_250;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				this.sendGateway({ op: 1, d: this.lastSequence });
			}, interval);
			this.heartbeatTimer.unref?.();

			this.sendGateway({
				op: 2,
				d: {
					token: this.getConfig().botToken,
					intents: DISCORD_GATEWAY_INTENTS,
					properties: {
						os: "linux",
						browser: "pi-web-ui",
						device: "pi-web-ui-discord-plugin",
					},
				},
			});
			return;
		}

		if (op === 1) {
			this.sendGateway({ op: 1, d: this.lastSequence });
			return;
		}

		if (op === 9) {
			this.log("warn", `Discord Gateway invalid session (payload=${JSON.stringify(d ?? null)})`);
			try {
				this.ws?.close();
			} catch {}
			return;
		}

		if (op !== 0) return;

		if (t === "READY") {
			void this.handleReady(d);
		} else if (t === "GUILD_CREATE") {
			const guildId = String(d?.id || "").trim();
			if (guildId) {
				this.knownGuilds.add(guildId);
				void this.registerGuildCommands(guildId);
			}
		} else if (t === "MESSAGE_CREATE") {
			void this.onInboundMessage(d);
		} else if (t === "THREAD_CREATE") {
			void this.onThreadCreate(d);
		} else if (t === "INTERACTION_CREATE") {
			void this.handleInteraction(d);
		}
	}

	sendGateway(payload) {
		if (!this.ws || this.ws.readyState !== 1) return false;
		try {
			this.ws.send(JSON.stringify(payload));
			return true;
		} catch (error) {
			this.log("warn", `Discord Gateway send failed: ${error?.message || error}`);
			return false;
		}
	}

	async handleReady(data) {
		this.botUser = data?.user || {};
		this.status.botUsername = this.botUser.username || "";
		this.status.botUserId = this.botUser.id || "";
		this.applicationId = String(data?.application?.id || "").trim();
		this.status.applicationId = this.applicationId;
		this.status.connected = true;
		this.status.state = "connected";
		this.status.lastError = null;
		this.log("info", `Discord bot connected as @${this.status.botUsername}`);

		for (const guild of Array.isArray(data?.guilds) ? data.guilds : []) {
			const guildId = String(guild?.id || "").trim();
			if (guildId) this.knownGuilds.add(guildId);
		}

		if (!this.applicationId) {
			try {
				const application = await this.api(this.getConfig().botToken, "GET", "/oauth2/applications/@me");
				this.applicationId = String(application?.id || "").trim();
				this.status.applicationId = this.applicationId;
			} catch (error) {
				this.log("warn", `Could not resolve the Discord application ID: ${error?.message || error}`);
			}
		}

		await this.registerGlobalCommands();
		await this.registerKnownGuildCommands();
	}

	async registerKnownGuildCommands() {
		for (const guildId of [...this.knownGuilds].sort()) {
			await this.registerGuildCommands(guildId);
		}
	}

	async registerGuildCommands(guildId) {
		const id = String(guildId || "").trim();
		const applicationId = String(this.applicationId || "").trim();
		const token = this.getConfig().botToken;
		if (!id || !applicationId || !token) return false;
		if (this.registeredGuilds.has(id)) return true;
		const inFlight = this.commandRegistrations.get(id);
		if (inFlight) return inFlight;

		const registration = (async () => {
			try {
				const registered = await this.api(
					token,
					"PUT",
					`/applications/${applicationId}/guilds/${id}/commands`,
					buildCommandPayload(),
				);
				const count = Array.isArray(registered) ? registered.length : DISCORD_COMMANDS.length;
				this.status.registeredCommands = count;
				this.registeredGuilds.add(id);
				this.log("info", `Registered ${count} native Discord commands in guild ${id}`);
				return true;
			} catch (error) {
				this.status.lastError = error?.message || String(error);
				this.log("warn", `Discord command registration failed for guild ${id}: ${this.status.lastError}`);
				return false;
			}
		})();
		this.commandRegistrations.set(id, registration);
		try {
			return await registration;
		} finally {
			if (this.commandRegistrations.get(id) === registration) {
				this.commandRegistrations.delete(id);
			}
		}
	}

	async registerGlobalCommands() {
		const applicationId = String(this.applicationId || "").trim();
		const token = this.getConfig().botToken;
		if (!applicationId || !token) return false;
		if (this.registeredGlobally) return true;

		try {
			const registered = await this.api(
				token,
				"PUT",
				`/applications/${applicationId}/commands`,
				buildCommandPayload(),
			);
			const count = Array.isArray(registered) ? registered.length : DISCORD_COMMANDS.length;
			this.status.registeredCommands = count;
			this.registeredGlobally = true;
			this.status.registeredGlobally = true;
			this.log("info", `Registered ${count} global native Discord commands`);
			return true;
		} catch (error) {
			this.status.lastError = error?.message || String(error);
			this.log("warn", `Discord global command registration failed: ${this.status.lastError}`);
			return false;
		}
	}

	async handleInteraction(interaction) {
		const type = Number(interaction?.type);
		if (type === INTERACTION_TYPE.PING) {
			await this.respondToInteraction(interaction, { type: INTERACTION_RESPONSE_TYPE.PONG });
			return;
		}
		if (type === INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE) {
			await this.handleAutocompleteInteraction(interaction);
			return;
		}
		if (type === INTERACTION_TYPE.APPLICATION_COMMAND) {
			await this.handleApplicationCommand(interaction);
		}
	}

	async respondToInteraction(interaction, payload) {
		const token = this.getConfig().botToken;
		return this.api(
			token,
			"POST",
			`/interactions/${interaction.id}/${interaction.token}/callback`,
			payload,
		);
	}

	/**
	 * Whether an interaction response should be ephemeral.
	 *
	 * Every slash-command answer is ephemeral: the command output is meant
	 * for the person who ran the command, not for the channel history.
	 */
	interactionFlags() {
		return DISCORD_EPHEMERAL_FLAG;
	}

	/**
	 * Reply flags for a prompt response.
	 *
	 * A guild channel and the app's own DM can carry a public reply — that is
	 * what the @mention flow posts. A third-party DM has no bot presence for a
	 * user-installed app, so the answer must stay ephemeral or delivery fails.
	 * The same applies to a guild where the app is only installed to the user's
	 * account: without a guild membership the bot cannot post there.
	 */
	promptInteractionFlags(interaction) {
		const context = Number(interaction?.context ?? 0);
		if (context === INTERACTION_CONTEXT.PRIVATE_CHANNEL) return DISCORD_EPHEMERAL_FLAG;
		const guildId = String(interaction?.guild_id || "").trim();
		if (guildId && !this.knownGuilds.has(guildId)) return DISCORD_EPHEMERAL_FLAG;
		return null;
	}

	async deferInteraction(interaction, flags = this.interactionFlags(interaction)) {
		await this.respondToInteraction(interaction, {
			type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
			data: { ...(flags !== null ? { flags } : {}) },
		});
	}

	async editInteractionResponse(interaction, content, flags = this.interactionFlags(interaction)) {
		const applicationId = String(interaction?.application_id || this.applicationId || "").trim();
		if (!applicationId) throw new Error("Discord application ID is unavailable.");
		return this.api(
			this.getConfig().botToken,
			"PATCH",
			`/webhooks/${applicationId}/${interaction.token}/messages/@original`,
			{ content, ...(flags !== null ? { flags } : {}) },
		);
	}

	/** Post an additional chunk through the interaction webhook. */
	async postInteractionFollowup(interaction, content, flags = this.interactionFlags(interaction)) {
		const applicationId = String(interaction?.application_id || this.applicationId || "").trim();
		if (!applicationId) throw new Error("Discord application ID is unavailable.");
		return this.api(
			this.getConfig().botToken,
			"POST",
			`/webhooks/${applicationId}/${interaction.token}`,
			{ content, ...(flags !== null ? { flags } : {}) },
		);
	}

	/**
	 * Answer an interaction with possibly long content.
	 *
	 * Discord caps a single message at 2000 characters, so the text is split
	 * and the overflow is posted as webhook follow-ups.
	 */
	async sendInteractionContent(interaction, content, { edit = false, flags = this.interactionFlags(interaction) } = {}) {
		const chunks = chunkMarkdownText(content, DISCORD_MESSAGE_LIMIT);
		if (!chunks.length) return;
		if (edit) {
			await this.editInteractionResponse(interaction, chunks[0], flags);
		} else {
			await this.respondToInteraction(interaction, {
				type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
				data: { content: chunks[0], ...(flags !== null ? { flags } : {}) },
			});
		}
		for (const chunk of chunks.slice(1)) {
			await this.postInteractionFollowup(interaction, chunk, flags);
		}
	}

	async handleApplicationCommand(interaction) {
		const authorId = String(interaction?.member?.user?.id || interaction?.user?.id || "").trim();
		const config = this.getConfig();
		const scope = await this.resolveScope({
			guildId: interaction?.guild_id,
			channelId: interaction?.channel_id,
			config,
		});
		if (!isAllowedUser(config, authorId)) {
			await this.respondToInteraction(interaction, {
				type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
				data: {
					content: "Access denied. Add your Discord User ID to the bot allowlist in pi-web-ui.",
					flags: DISCORD_EPHEMERAL_FLAG,
				},
			});
			return;
		}

		const name = String(interaction?.data?.name || "").toLowerCase();

		// `/pi` and `/pi-message` run the agent, so they own the whole
		// interaction lifecycle (defer, dispatch, edit) instead of the
		// single-reply command flow below.
		if (name === "pi" || name === "pi-message") {
			await this.handlePromptCommand(interaction, { authorId, config, name });
			return;
		}
		if (name === "read") {
			await this.handleReadCommand(interaction, { authorId, config });
			return;
		}
		if (name === "context") {
			await this.handleContextCommand(interaction, { authorId });
			return;
		}

		let deferred = false;
		try {
			await this.deferInteraction(interaction, DISCORD_EPHEMERAL_FLAG);
			deferred = true;
		} catch (error) {
			this.log("warn", `Discord interaction defer failed: ${error?.message || error}`);
		}

		let args = "";
		if (name === "cwd") args = interactionOption(interaction, "path");
		if (name === "model") {
			args = {
				model: interactionOption(interaction, "model"),
				thinking: interactionOption(interaction, "thinking"),
			};
		}
		if (name === "system") {
			args = {
				replace: interactionOption(interaction, "replace"),
				append: interactionOption(interaction, "append"),
			};
		}

		try {
			const content = await this.executeCommand(name, args, { authorId, config, scope });
			const finalContent = content || `Unknown command: /${name}`;
			if (deferred) {
				await this.sendInteractionContent(interaction, finalContent, {
					edit: true,
					flags: DISCORD_EPHEMERAL_FLAG,
				});
			} else {
				await this.sendInteractionContent(interaction, finalContent, { flags: DISCORD_EPHEMERAL_FLAG });
			}
		} catch (error) {
			const finalContent = `Command failed: ${error?.message || error}`;
			if (deferred) {
				await this.editInteractionResponse(interaction, finalContent, DISCORD_EPHEMERAL_FLAG).catch(() => {});
			} else {
				await this.respondToInteraction(interaction, {
					type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: finalContent, flags: DISCORD_EPHEMERAL_FLAG },
				}).catch(() => {});
			}
		}
	}

	/**
	 * Fetch the most recent messages of a channel.
	 *
	 * A user-installed app has no presence in a third-party DM or group chat, so
	 * Discord denies this endpoint there. The caller degrades gracefully instead
	 * of failing the whole command.
	 */
	async fetchChannelMessages(channelId, count, config = this.getConfig()) {
		const limit = normalizeReadCount(count, 0);
		const channel = String(channelId || "").trim();
		if (!channel || limit <= 0) return { messages: [], error: "", limit };
		try {
			const messages = await this.api(config?.botToken, "GET", `/channels/${channel}/messages?limit=${limit}`);
			return { messages: Array.isArray(messages) ? messages : [], error: "", limit };
		} catch (error) {
			return { messages: [], error: String(error?.message || error), limit };
		}
	}

	/**
	 * Build the recent-message context block for a channel.
	 */
	async buildChannelContext(channelId, count, config = this.getConfig()) {
		const requested = normalizeReadCount(count, DISCORD_READ_DEFAULT_COUNT);
		if (requested <= 0) return { text: "", error: "", requested, available: 0 };
		const result = await this.fetchChannelMessages(channelId, requested, config);
		return {
			text: formatChannelContext(result.messages, { botId: String(this.botUser?.id || "") }),
			error: result.error,
			requested,
			available: result.messages.length,
		};
	}

	/**
	 * Explain that Discord will not let a user-installed app read a channel.
	 */
	historyUnavailableMessage(error = "") {
		return [
			"❌ Could not read the channel history here.",
			error ? `- Discord said: ${error}` : "",
			"- Apps installed to a user account have no presence in third-party DMs and group chats, so Discord only lets them answer the interaction itself.",
			"- `/pi <message>` still works everywhere — it sends the prompt without the channel transcript.",
			"- To use a specific message as the prompt, right-click it → Apps → **pi-message**.",
		]
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Handle `/read` — load the most recent messages of the current channel
	 * into the chat context.
	 *
	 * No agent turn is triggered: the messages are stored and carried by the
	 * next prompt, wherever that prompt is sent from.
	 */
	async handleReadCommand(interaction, { authorId = "", config = this.getConfig() } = {}) {
		const channelId = String(interaction?.channel_id || "").trim();
		if (!channelId) {
			await this.sendInteractionContent(interaction, "❌ `/read` needs a channel context.");
			return;
		}
		const requested = normalizeReadCount(interactionOption(interaction, "count"), DISCORD_READ_DEFAULT_COUNT);
		const result = await this.fetchChannelMessages(channelId, requested, config);
		if (result.error) {
			await this.sendInteractionContent(interaction, this.historyUnavailableMessage(result.error));
			return;
		}
		if (!result.messages.length) {
			await this.sendInteractionContent(interaction, "📭 No messages found in this channel.");
			return;
		}

		const botId = String(this.botUser?.id || "");
		const batch = await this.loadChannelContext(
			authorId,
			channelId,
			await this.resolveChannelName(channelId, config),
			result.messages.map((message) => normalizeLoadedMessage(message, botId)),
		);

		const total = this.loadedBatches(authorId).reduce((sum, entry) => sum + entry.messages.length, 0);
		const count = batch.messages.length;
		const lines = [
			`✅ **${count} message${count === 1 ? "" : "s"} loaded into the chat context.**`,
			total > count ? `The chat context now holds ${total} messages in total.` : "",
			"- No agent turn was triggered.",
			"- The next prompt you send will include them, in this or any other channel.",
			"- Use `/context clear` to drop the loaded context.",
		];
		await this.sendInteractionContent(interaction, lines.filter(Boolean).join("\n"), {
			flags: DISCORD_EPHEMERAL_FLAG,
		});
	}

	/**
	 * Handle `/context` — show or clear the context loaded with `/read`.
	 */
	async handleContextCommand(interaction, { authorId = "" } = {}) {
		const action = (interactionOption(interaction, "action") || "show").toLowerCase();
		if (action === "clear") {
			await this.clearUserContext(authorId);
			await this.sendInteractionContent(interaction, "🧹 Chat context cleared.", { flags: DISCORD_EPHEMERAL_FLAG });
			return;
		}
		const batches = this.loadedBatches(authorId);
		if (!batches.length) {
			await this.sendInteractionContent(
				interaction,
				"📭 No Discord context is loaded. Use `/read [count]` in a channel to load it.",
				{ flags: DISCORD_EPHEMERAL_FLAG },
			);
			return;
		}
		const lines = ["### Loaded chat context", ""];
		for (const batch of batches) {
			lines.push(`- **${batch.channelName || batch.channelId}** — ${batch.messages.length} message${batch.messages.length === 1 ? "" : "s"}`);
		}
		lines.push("", "Use `/context clear` to drop it.");
		await this.sendInteractionContent(interaction, lines.join("\n"), { flags: DISCORD_EPHEMERAL_FLAG });
	}

	/** Best-effort channel name, used to label the loaded context. */
	async resolveChannelName(channelId, config = this.getConfig()) {
		const channel = String(channelId || "").trim();
		if (!channel) return "";
		try {
			const data = await this.api(config?.botToken, "GET", `/channels/${channel}`);
			const name = String(data?.name || "").trim();
			return name ? `#${name}` : channel;
		} catch {
			return channel;
		}
	}

	/**
	 * Handle `/pi` and `/pi-message` — run a prompt through the agent.
	 *
	 * The prompt travels through exactly the same pipeline as an @mention, so
	 * the conversation, workspace, model, and thinking level are shared.
	 */
	async handlePromptCommand(interaction, { authorId = "", config = this.getConfig(), name = "pi" } = {}) {
		const channelId = String(interaction?.channel_id || "").trim();
		const flags = this.promptInteractionFlags(interaction);
		let prompt = "";
		let requested = DISCORD_READ_DEFAULT_COUNT;

		if (name === "pi-message") {
			const targetId = String(interaction?.data?.target_id || "").trim();
			const resolved = interaction?.data?.resolved?.messages || {};
			prompt = String(resolved?.[targetId]?.content || "").trim();
			requested = 1;
		} else {
			prompt = String(interactionOption(interaction, "message") || "").trim();
			requested = normalizeReadCount(interactionOption(interaction, "context"), DISCORD_READ_DEFAULT_COUNT);
		}

		if (!prompt) {
			await this.respondToInteraction(interaction, {
				type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
				data: { content: "❌ `/pi` needs a message to send to the agent.", ...(flags !== null ? { flags } : {}) },
			});
			return;
		}

		let deferred = false;
		try {
			await this.deferInteraction(interaction, flags);
			deferred = true;
		} catch (error) {
			this.log("warn", `Discord interaction defer failed: ${error?.message || error}`);
		}

		const context = await this.buildChannelContext(channelId, requested, config);
		if (context.error) {
			this.log("info", `Discord channel history unavailable for ${channelId}: ${context.error}`);
		}

		this.status.messagesReceived += 1;
		this.status.lastMessageAt = Date.now();

		const scope = await this.resolveScope({
			guildId: interaction?.guild_id,
			channelId,
			config,
		});
		const run = this.createRun({
			channelId,
			authorId,
			interaction: deferred ? interaction : null,
			isGuild: Boolean(interaction?.guild_id),
			scope,
		});
		const request = await this.buildRequest({
			text: prompt,
			config,
			replyContext: context.text,
			authorId,
			scope,
			// /pi already reads this channel itself, so the loaded batch of the
			// same channel is skipped to avoid repeating the same messages.
			excludeContextChannelId: channelId,
		});
		await this.enqueueDispatch(run, request);
	}

	async handleAutocompleteInteraction(interaction) {
		const authorId = String(interaction?.member?.user?.id || interaction?.user?.id || "").trim();
		const config = this.getConfig();
		let choices = [];
		if (isAllowedUser(config, authorId)) {
			const name = String(interaction?.data?.name || "").toLowerCase();
			const focused = interaction?.data?.options?.find((option) => option?.focused);
			const query = String(focused?.value || "").trim();
			if (name === "cwd") {
				const root = await this.resolveWorkspace(authorId, config);
				if (root) choices = await buildDirectoryChoices(root, query, { fsImpl: this.fs });
			} else if (name === "model") {
				const catalog = await this.getModelCatalog();
				choices = modelChoices(catalog, query);
			}
		}
		await this.respondToInteraction(interaction, {
			type: INTERACTION_RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
			data: { choices },
		});
	}

	async getModelCatalog(force = false) {
		const fresh = Date.now() - this.modelCatalogAt < MODEL_CACHE_MS;
		if (!force && fresh && this.modelCatalog.length > 0) return this.modelCatalog;
		try {
			const models = await withTimeout(
				Promise.resolve(this.host?.models?.list?.() || []),
				AUTOCOMPLETE_TIMEOUT_MS,
				[],
			);
			this.modelCatalog = normalizeModelCatalog(models);
			this.modelCatalogAt = Date.now();
		} catch {
			this.modelCatalog = [];
		}
		return this.modelCatalog;
	}

	async refreshModelCatalog() {
		return this.getModelCatalog(true);
	}

	async executeCommand(name, args = "", { authorId = "", config = this.getConfig(), scope = "dm" } = {}) {
		const command = String(name || "").toLowerCase();
		const argument = typeof args === "string" ? String(args || "").trim() : "";
		const optionPayload = args && typeof args === "object" ? args : {};

		if (command === "help") {
			return [
				"### pi-web-ui Discord bot",
				"- Send a message to start a multi-turn conversation with the pi agent.",
				"- `/help` — show this help.",
				"- `/status` — show gateway, counters, and command registration status.",
				"- `/new` — start a fresh conversation.",
				"- `/new` — start a fresh conversation (clears the stored session id).",
				"- `/clear` — alias of `/new`; both drop the stored session id.",
				"- `/cancel` — cancel the running task.",
				"- `/cwd [path]` — show or change the workspace directory.",
				"- `/model [provider/model] [thinking]` — show or change the AI model and the thinking level.",
				"- `/model high` — only change the thinking level (off, low, medium, high, max).",
				"- `/system` — show the current Discord core system prompt.",
				"- `/system replace <text>` — replace the core system prompt.",
				"- `/system append <text>` — append to the core system prompt.",
				"- `/read [count]` — load the last messages of this channel into the chat context (default 5).",
				"- `/context` — show the context loaded with `/read`.",
				"- `/context clear` — drop the loaded context.",
				"- `/pi <message> [context]` — send a prompt to the agent, like @pi but usable in DMs.",
				"- `pi-message` — right-click a message → Apps → pi-message, to use it as the prompt.",
				"",
				"Native slash commands are registered globally and per guild.",
				"Installing this app to your own account lets you use it in your servers, DMs, and group chats.",
				"Plain-text commands remain supported.",
				"Messages in channels configured for automatic replies reach the bot without an @mention,",
				"and replying to a message adds that message as context.",
				"The context loaded with `/read` is carried by every later prompt until it is cleared.",
			].join("\n");
		}

		if (command === "status") {
			const status = this.getStatus();
			const workspace = await this.resolveWorkspace(authorId, config) || "(host default)";
			const guilds = status.registeredGuilds.length
				? status.registeredGuilds.join(", ")
				: "none yet";
			const key = this.sessionKeyFor(scope, authorId);
			const sessionId =
				this.activeConversationFor(key) ||
				String(this.userSessions.get(key)?.conversationId || "").trim() ||
				"(none yet)";
			return [
				"### Discord bot status",
				`- Bot: @${status.botUsername || "not connected"}`,
				`- Gateway: ${status.state}`,
				`- Application ID: ${status.applicationId || "unknown"}`,
				`- Native commands registered: ${status.registeredCommands}`,
				`- Guilds with registered commands: ${guilds}`,
				`- Global commands registered: ${this.status.registeredGlobally ? "yes" : "no"}`,
				`- User install: https://discord.com/oauth2/authorize?bot_id=${this.applicationId || "CLIENT_ID"}&integration_type=1&scope=applications.commands`,
				`- Messages received: ${status.messagesReceived}`,
				`- Replies sent: ${status.messagesReplied}`,
				"",
				"### This user",
				`- Discord user: ${authorId || "unknown"}`,
				`- Scope: \`${scope}\``,
				`- Pi session id: \`${sessionId}\``,
				`- Session account: \`${this.userAccountId(key)}\``,
				`- Workspace: ${workspace || "(host default)"}`,
				`- Model: ${config.model || "(host default)"}`,
				`- Thinking level: ${config.thinkingLevel || "(host default)"}`,
				`- Automatic replies: ${config.autoReplyEnabled ? "on" : "off"}`,
				`- Automatic reply channels: ${autoReplyChannels(config).join(", ") || "none"}`,
				`- Workspace session reuse: ${config.useWorkspaceSession === false ? "off" : "on"}`,
				`- Tool trace: ${config.showToolCalls ? "on" : "off"}`,
				`- Live replies: ${config.liveReplyEnabled ? "on" : "off"}`,
				`- Attachments: ${config.allowAttachments ? "on" : "off"}`,
			].join("\n");
		}

		if (command === "new") {
			const key = this.sessionKeyFor(scope, authorId);
			await this.resetUserConversation(key, { authorId });
			return "✨ Conversation context cleared. The stored session id was removed; the next message starts a new session.";
		}

		if (command === "cancel") {
			const key = this.sessionKeyFor(scope, authorId);
			const conversationId = this.activeConversationFor(key);
			if (!conversationId) return "ℹ️ There is no running task to cancel.";
			for (const run of this.pendingRuns.values()) {
				if (run.authorId === authorId) run.cancelled = true;
			}
			const result = await this.host?.abortRun?.(conversationId);
			if (result?.ok) return "🛑 Cancelled the running task.";
			return `❌ Could not cancel the running task: ${result?.error || "the host rejected the abort request."}`;
		}

		if (command === "cwd") {
			if (!argument) {
				const workspace = (await this.resolveWorkspace(authorId, config)) || "(host default)";
				return `📂 Current workspace: ${workspace}\nUse \`/cwd <path>\` to switch directories.`;
			}
			const currentRoot = (await this.resolveWorkspace(authorId, config)) || this.host?.cwd || process.cwd();
			const targetPath = isAbsolute(argument) ? resolve(argument) : resolve(currentRoot, argument);
			let stat;
			try {
				stat = await this.fs.stat(targetPath);
			} catch {
				return `❌ Workspace does not exist: ${targetPath}`;
			}
			if (!stat?.isDirectory?.()) return `❌ Workspace is not a directory: ${targetPath}`;
			this.userWorkspaces.set(authorId, targetPath);
			await this.persistUserWorkspaces(Object.fromEntries(this.userWorkspaces));
			await this.resetUserConversation(this.sessionKeyFor(scope, authorId), { authorId });
			return `📂 Workspace changed to: ${targetPath}\n✨ A fresh session was created for the new workspace.`;
		}

		if (command === "model") {
			let requested;
			if (typeof args === "object" && args !== null) {
				const rawThinking = String(optionPayload.thinking || "").trim();
				const isReset = ["default", "host", "none", "reset"].includes(rawThinking.toLowerCase());
				const level = rawThinking && !isReset ? normalizeThinkingLevel(rawThinking) : "";
				requested = {
					model: String(optionPayload.model || "").trim(),
					thinking: level,
					thinkingReset: isReset,
					invalid: rawThinking && !level && !isReset ? rawThinking : "",
				};
			} else {
				requested = parseModelArguments(argument);
			}
			if (requested.invalid) {
				return `❌ Unknown option: ${requested.invalid}\nUse \`/model provider/model\` or \`/model ${THINKING_LEVELS.join("|")}\`.`;
			}
			const wantsShow = !requested.model && !requested.thinking && !requested.thinkingReset;
			if (wantsShow) {
				return [
					"### Current AI configuration",
					`- Model: \`${config.model || "(host default)"}\``,
					`- Thinking level: \`${config.thinkingLevel || "(host default)"}\``,
					"Use `/model provider/model` to change the model.",
					`Use \`/model ${THINKING_LEVELS.join("|")}\` to change the thinking level.`,
				].join("\n");
			}
			const changed = [];
			if (requested.model) {
				const catalog = await this.getModelCatalog();
				if (catalog.length > 0 && !catalog.includes(requested.model)) {
					return `❌ Unknown model: ${requested.model}\nUse the autocomplete list or check the configured model IDs.`;
				}
				await this.updateConfig({ model: requested.model });
				changed.push(`AI model changed to: ${requested.model}`);
			}
			if (requested.thinking) {
				await this.updateConfig({ thinkingLevel: requested.thinking });
				changed.push(`Thinking level changed to: ${requested.thinking}`);
			} else if (requested.thinkingReset) {
				await this.updateConfig({ thinkingLevel: "" });
				changed.push("Thinking level reset to the host default.");
			}
			return changed.map((line) => `✨ ${line}`).join("\n");
		}

		if (command === "system") {
			const systemOptions = typeof args === "object" && args !== null
				? { replace: optionPayload.replace || "", append: optionPayload.append || "" }
				: parseSystemCommandArgument(argument);
			const invalid = String(systemOptions.invalid || "").trim();
			if (invalid) {
				return `❌ Unknown /system option: ${invalid}\nUse \`/system replace <text>\` or \`/system append <text>\`.`;
			}
			const parsed = parseSystemArguments(systemOptions);
			if (parsed.error) return `❌ ${parsed.error}`;
			if (!parsed.mode) {
				const mode = config.systemPromptMode || (config.systemPrompt ? "replace" : "default");
				return [
					"### Discord core system prompt",
					`- Mode: ${mode}`,
					"",
					buildCorePrompt(config),
				].join("\n");
			}
			if (parsed.mode === "replace") {
				await this.updateConfig({ systemPrompt: parsed.text, systemPromptMode: "replace" });
				return [
					"✨ Discord core system prompt replaced.",
					"It applies to the current conversation from the next message on.",
				].join("\n");
			}
			await this.updateConfig({
				systemPrompt: appendCorePrompt(config, parsed.text),
				systemPromptMode: "append",
			});
			return [
				"✨ Discord core system prompt updated.",
				"It applies to the current conversation from the next message on.",
			].join("\n");
		}

		return null;
	}

	/** The conversation a user is currently bound to (running run first, then last used). */
	activeConversationFor(key) {
		for (const run of this.pendingRuns.values()) {
			if (run.sessionKey === key && run.conversationId) return run.conversationId;
		}
		return String(this.userConversations.get(key) || "").trim();
	}

	/**
	 * Resolve the live pi-web-ui conversation that matches the Discord workspace.
	 *
	 * Returning its id lets the host steer that exact session, so Discord and the
	 * browser share one pi session even while it is open in pi-web-ui.
	 */
	/**
	 * The scope of a conversation: a DM or a guild channel.
	 *
	 * A thread continues the conversation of the channel it was started in, so
	 * the parent channel decides the scope.
	 */
	async resolveScope({ guildId = "", channelId = "", config = this.getConfig() } = {}) {
		const guild = String(guildId || "").trim();
		if (!guild) return "dm";
		const channel = String(channelId || "").trim();
		const info = await this.resolveChannelInfo(channel, config);
		const root = info?.parentId || channel;
		return sessionScope({ guildId: guild, channelId: root });
	}

	/** The session key of one user in one scope. */
	sessionKeyFor(scope, authorId) {
		return sessionKey(scope, authorId);
	}

	/** Metadata of a Discord channel, cached for a minute. */
	async resolveChannelInfo(channelId, config = this.getConfig()) {
		const id = String(channelId || "").trim();
		if (!id) return null;
		const cached = this.channelInfoCache.get(id);
		if (cached && cached.expiresAt > Date.now()) return cached.info;
		try {
			const data = await this.api(config?.botToken, "GET", `/channels/${id}`);
			const info = {
				type: Number(data?.type || 0),
				parentId: String(data?.parent_id || "").trim(),
				name: String(data?.name || "").trim(),
			};
			this.channelInfoCache.set(id, { info, expiresAt: Date.now() + CHANNEL_INFO_CACHE_MS });
			return info;
		} catch {
			return null;
		}
	}

	/** Remember a message the bot posted, so a thread started from it is found. */
	rememberBotMessage(message) {
		const id = String(message?.id || "").trim();
		if (!id) return;
		this.botMessageIds.add(id);
		while (this.botMessageIds.size > BOT_MESSAGE_MEMORY) {
			const oldest = this.botMessageIds.values().next().value;
			this.botMessageIds.delete(oldest);
		}
	}

	/**
	 * Enable automatic replies in a thread that was started from a bot reply.
	 *
	 * The setting lives in memory only: it follows the default channel
	 * automatic-reply switch and never changes the stored configuration.
	 */
	enableThreadAutoReply(threadId, parentMessageId = "") {
		const thread = String(threadId || "").trim();
		const parent = String(parentMessageId || "").trim();
		if (!thread || !parent) return false;
		if (!this.botMessageIds.has(parent)) return false;
		this.autoReplyThreadIds.add(thread);
		return true;
	}

	async resolveWorkspaceConversation(authorId, config = this.getConfig()) {
		if (config?.useWorkspaceSession === false) return "";
		const workspace = await this.resolveWorkspace(authorId, config);
		if (!workspace) return "";
		// Every Discord user works in a subfolder of the configured workspace,
		// but the session to reuse is the one pi-web-ui runs in the workspace
		// itself: both paths are accepted.
		const base = String(config?.workspace || this.host?.cwd || "").trim();
		const targets = new Set([resolve(workspace)]);
		if (base) targets.add(resolve(base));

		try {
			const active = await this.host?.getActiveConversation?.({ fallback: "latest-non-subagent" });
			const activeId = String(active?.conversationId || active?.id || "").trim();
			const activeCwd = String(active?.cwd || "").trim();
			if (activeId && activeCwd && targets.has(resolve(activeCwd))) return activeId;
		} catch {}

		try {
			const conversations = await this.host?.conversations?.list?.();
			for (const conversation of Array.isArray(conversations) ? conversations : []) {
				const id = String(conversation?.id || "").trim();
				if (!id || id.startsWith("/")) continue;
				const kind = String(conversation?.kind || "").trim();
				if (kind && kind !== "running") continue;
				const cwd = String(conversation?.cwd || "").trim();
				if (!cwd || !targets.has(resolve(cwd))) continue;
				return id;
			}
		} catch {}

		return "";
	}

	/** Fetch the message a Discord reply points at, so the agent gets that context. */
	async resolveReferencedMessage(message, config = this.getConfig()) {
		const embedded = message?.referenced_message;
		if (embedded) return embedded;
		const referenceId = String(message?.message_reference?.message_id || "").trim();
		if (!referenceId) return null;
		const channelId = String(message?.message_reference?.channel_id || message?.channel_id || "").trim();
		if (!channelId) return null;
		try {
			return await this.api(config?.botToken, "GET", `/channels/${channelId}/messages/${referenceId}`);
		} catch (error) {
			this.log("warn", `Discord reply context lookup failed: ${error?.message || error}`);
			return null;
		}
	}

	/** Remember an assistant-side error so the reply can explain the failure. */
	noteRunError(conversationId, message) {
		const text = String(message || "").trim();
		if (!text) return;
		this.runErrors.set(conversationId, text);
		const run = this.pendingRuns.get(conversationId) || this.activeDispatch?.run;
		if (run) run.lastError = text;
	}

	/**
	 * Handle a new Discord thread.
	 *
	 * A thread that starts from one of the bot's replies answers automatically.
	 * The switch lives in memory only and follows the default automatic-reply
	 * setting of the parent channel.
	 */
	async onThreadCreate(thread) {
		const threadId = String(thread?.id || "").trim();
		if (!threadId) return;
		const config = this.getConfig();
		const parentChannelId = String(thread?.parent_id || "").trim();
		const starter = thread?.message || null;
		const starterId = String(starter?.id || "").trim();
		const botId = String(this.botUser?.id || this.status.botUserId || "").trim();
		const starterAuthorId = String(starter?.author?.id || "").trim();
		const startedFromBot =
			Boolean(starterId) &&
			((botId && starterAuthorId === botId) || this.botMessageIds.has(starterId));
		const parentAutoReply = Boolean(parentChannelId) && isAutoReplyChannel(parentChannelId, config);
		if (!startedFromBot && !parentAutoReply) return;
		if (startedFromBot) {
			if (starterId) this.rememberBotMessage(starter);
			this.enableThreadAutoReply(threadId, starterId);
		} else if (parentAutoReply) {
			this.autoReplyThreadIds.add(threadId);
		}
		if (this.autoReplyThreadIds.has(threadId)) {
			this.log("info", `Automatic replies enabled for thread ${threadId}`);
		}
	}

	async onInboundMessage(message) {
		if (!message || message.author?.bot) return;

		const authorId = String(message.author?.id || "").trim();
		const channelId = String(message.channel_id || "").trim();
		const botId = String(this.botUser?.id || "").trim();
		const isGuild = Boolean(message.guild_id);
		const config = this.getConfig();
		const scope = await this.resolveScope({
			guildId: message.guild_id,
			channelId,
			config,
		});

		const referencedMessage = await this.resolveReferencedMessage(message, config);
		if (
			isGuild &&
			!isMessageAddressedToBot(message, {
				botId,
				config,
				referencedMessage,
				autoReplyThreadIds: this.autoReplyThreadIds,
			})
		) {
			return;
		}

		const cleanText = extractDiscordText(message, botId);
		if (!cleanText) return;

		if (!isAllowedUser(config, authorId)) {
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content: "Access denied. Add your Discord User ID to the bot allowlist in pi-web-ui.",
				...(isGuild ? { message_reference: { message_id: message.id } } : {}),
			}).catch(() => {});
			return;
		}

		this.status.messagesReceived += 1;
		this.status.lastMessageAt = Date.now();

		const parsed = parseLegacyCommand(cleanText);
		if (parsed && DISCORD_COMMANDS.some((command) => command.type === 1 && command.name === parsed.name)) {
			await this.handleLegacyCommand(parsed, {
				channelId,
				authorId,
				replyToId: message.id,
				config,
				scope,
				isGuild,
			});
			return;
		}

		void this.api(config.botToken, "POST", `/channels/${channelId}/typing`, null).catch(() => {});

		const replyContext = buildReplyContext(referencedMessage, { botId });
		const attachments = await this.collectAttachmentContext(message, { config, authorId });
		const run = this.createRun({ channelId, authorId, replyToMessageId: message.id, isGuild, scope });
		const request = await this.buildRequest({
			text: cleanText,
			config,
			replyContext,
			authorId,
			attachments,
			scope,
		});

		await this.enqueueDispatch(run, request);
	}

	/**
	 * Create the bookkeeping record for one agent turn.
	 *
	 * `interaction` is set when the turn was started by a slash command: the
	 * answer is then published through the interaction response instead of a
	 * channel message, which is the only channel a user-installed app can use
	 * in a third-party DM.
	 */
	createRun({
		channelId = "",
		authorId = "",
		replyToMessageId = "",
		interaction = null,
		isGuild = false,
		scope = "dm",
	} = {}) {
		const sessionKey = this.sessionKeyFor(scope, authorId);
		const generation = Number(this.userGenerations.get(sessionKey) || 0);
		const run = {
			channelId,
			authorId,
			isGuild,
			scope,
			sessionKey,
			replyToMessageId,
			interaction,
			accumulatedText: "",
			startedAt: Date.now(),
			dispatchedAt: 0,
			clientId: "",
			requestText: "",
			sharedConversation: false,
			sawUserMessage: false,
			sawTurnStart: false,
			turnOpened: false,
			settleTimer: null,
			segments: [],
			liveEnabled: this.getConfig().liveReplyEnabled === true && !interaction,
			liveMessageId: "",
			livePageStart: 0,
			liveRenderedLength: 0,
			liveUpdatedAt: 0,
			liveTimer: null,
			generation,
			cancelled: false,
			finished: false,
			delivered: false,
			conversationId: "",
			stopReason: "",
			lastError: "",
			resolveCompletion: null,
			timeoutTimer: null,
		};
		const completion = new Promise((resolve) => {
			run.resolveCompletion = resolve;
		});
		run.completion = completion;
		return run;
	}

	/** Build the pi-web-ui request for one agent turn. */
	async buildRequest({
		text = "",
		config = {},
		replyContext = "",
		authorId = "",
		excludeContextChannelId = "",
		attachments = "",
		scope = "dm",
	} = {}) {
		const key = this.sessionKeyFor(scope, authorId);
		const accountId = this.userAccountId(key);
		const botId = String(this.botUser?.id || "");
		const loadedContext = formatLoadedContext(
			this.loadedBatches(authorId, { excludeChannelId: excludeContextChannelId }),
			{ botId },
		);
		const request = {
			text: buildRequestText({
				text,
				config,
				replyContext,
				loadedContext,
				attachments,
				corePrompt: this.corePromptInjection(authorId, config),
			}),
			accountId,
		};
		const workspace = await this.resolveWorkspace(authorId, config);
		if (workspace) request.cwd = workspace;
		if (config.model) request.model = config.model;
		if (config.thinkingLevel) request.thinkingLevel = config.thinkingLevel;
		const sessionTarget = await this.resolveSessionTarget({ key, scope, authorId, config });
		if (sessionTarget) request.conversationId = sessionTarget;
		return request;
	}

	async handleLegacyCommand(parsed, { channelId, authorId, replyToId, config, scope = "dm", isGuild = false }) {
		try {
			if (parsed.name === "pi") {
				await this.runLegacyPrompt({
					text: parsed.args,
					channelId,
					authorId,
					replyToId,
					config,
					scope,
					isGuild,
				});
				return true;
			}
			if (parsed.name === "read") {
				const count = normalizeReadCount(parsed.args, DISCORD_READ_DEFAULT_COUNT);
				const result = await this.fetchChannelMessages(channelId, count, config);
				if (result.error) {
					await this.postChannelText(channelId, config, this.historyUnavailableMessage(result.error), replyToId);
					return true;
				}
				if (!result.messages.length) {
					await this.postChannelText(channelId, config, "📭 No messages found in this channel.", replyToId);
					return true;
				}
				const botId = String(this.botUser?.id || "");
				const batch = await this.loadChannelContext(
					authorId,
					channelId,
					await this.resolveChannelName(channelId, config),
					result.messages.map((message) => normalizeLoadedMessage(message, botId)),
				);
				const count2 = batch.messages.length;
				await this.postChannelText(
					channelId,
					config,
					[
						`✅ **${count2} message${count2 === 1 ? "" : "s"} loaded into the chat context.**`,
						"- No agent turn was triggered.",
						"- The next prompt you send will include them, in this or any other channel.",
						"- Use `/context clear` to drop the loaded context.",
					].join("\n"),
					replyToId,
				);
				return true;
			}
			if (parsed.name === "context") {
				const action = (parsed.args || "show").toLowerCase();
				if (action === "clear") {
					await this.clearUserContext(authorId);
					await this.postChannelText(channelId, config, "🧹 Chat context cleared.", replyToId);
					return true;
				}
				const batches = this.loadedBatches(authorId);
				const lines = batches.length
					? [
							"### Loaded chat context",
							"",
							...batches.map((batch) => `- **${batch.channelName || batch.channelId}** — ${batch.messages.length} message${batch.messages.length === 1 ? "" : "s"}`),
							"",
							"Use `/context clear` to drop it.",
						].join("\n")
					: "📭 No Discord context is loaded. Use `/read [count]` in a channel to load it.";
				await this.postChannelText(channelId, config, lines, replyToId);
				return true;
			}
			const content = await this.executeCommand(parsed.name, parsed.args, {
				authorId,
				config,
				scope,
			});
			if (content === null) return false;
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content,
				...(isGuild && replyToId ? { message_reference: { message_id: replyToId } } : {}),
			});
			return true;
		} catch (error) {
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content: `Command failed: ${error?.message || error}`,
				...(isGuild && replyToId ? { message_reference: { message_id: replyToId } } : {}),
			}).catch(() => {});
			return true;
		}
	}

	/**
	 * Post a text message to a channel, optionally as a reply.
	 *
	 * Long text is split so nothing is silently truncated.
	 */
	async postChannelText(channelId, config = this.getConfig(), content = "", replyToId = "", { isGuild = true } = {}) {
		for (const chunk of chunkMarkdownText(content, DISCORD_MESSAGE_LIMIT)) {
			await this.api(config?.botToken, "POST", `/channels/${channelId}/messages`, {
				content: chunk,
				...(isGuild && replyToId ? { message_reference: { message_id: replyToId } } : {}),
			});
		}
	}

	/**
	 * Run a prompt typed as plain text (`/pi ...` without picking the command).
	 */
	async runLegacyPrompt({
		text = "",
		channelId = "",
		authorId = "",
		replyToId = "",
		config = this.getConfig(),
		scope = "dm",
		isGuild = false,
	} = {}) {
		const prompt = String(text || "").trim();
		if (!prompt) {
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content: "❌ `/pi` needs a message to send to the agent.",
				...(isGuild && replyToId ? { message_reference: { message_id: replyToId } } : {}),
			}).catch(() => {});
			return;
		}
		const context = await this.buildChannelContext(channelId, DISCORD_READ_DEFAULT_COUNT, config);
		const run = this.createRun({ channelId, authorId, replyToMessageId: replyToId, isGuild, scope });
		const request = await this.buildRequest({
			text: prompt,
			config,
			replyContext: context.text,
			authorId,
			scope,
		});
		await this.enqueueDispatch(run, request);
	}

	enqueueDispatch(run, request) {
		const task = this.dispatchTail.then(() => this.dispatchAndWait(run, request));
		this.dispatchTail = task.catch(() => {});
		return task;
	}

	async dispatchAndWait(run, request) {
		this.activeDispatch = { run, earlyConversationId: "" };
		run.timeoutTimer = setTimeout(() => {
			void this.finishRun(run, { timedOut: true });
		}, DEFAULT_RUN_TIMEOUT_MS);
		run.timeoutTimer.unref?.();

		run.dispatchedAt = Date.now();
		run.requestText = String(request.text || "");
		run.sharedConversation = Boolean(request.conversationId);

		try {
			const dispatched = await this.host.chat(request);
			const conversationId = String(dispatched?.conversationId || "").trim();
			run.clientId = String(dispatched?.clientId || "").trim();
			const expectedClientId = `plugin:discord:${request.accountId}`;
			if (
				!request.conversationId &&
				dispatched?.clientId &&
				dispatched.clientId !== expectedClientId
			) {
				throw new Error(
					`pi-web-ui routed the request to ${dispatched.clientId} instead of ${expectedClientId}`,
				);
			}
			if (!conversationId) throw new Error("pi-web-ui did not return a conversation ID");

			run.conversationId = conversationId;
			await this.rememberUserSession(run.sessionKey, conversationId);
			if (!run.finished) this.pendingRuns.set(conversationId, run);

			const early = this.earlyRuns.get(conversationId);
			if (early?.accumulatedText && !run.accumulatedText) {
				const earlyAt = Number(early.firstAt || 0);
				const stale =
					earlyAt > 0 && run.dispatchedAt > 0 && earlyAt < run.dispatchedAt - EVENT_CLOCK_SKEW_MS;
				if (!stale) run.accumulatedText = early.accumulatedText;
			}
			this.earlyRuns.delete(conversationId);

			await run.completion;
		} catch (error) {
			this.pendingRuns.delete(run.conversationId);
			const config = this.getConfig();
			await this.api(config.botToken, "POST", `/channels/${run.channelId}/messages`, {
				content: `Task failed to start: ${error?.message || error}`,
				message_reference: run.replyToMessageId
					? { message_id: run.replyToMessageId }
					: undefined,
			}).catch(() => {});
			run.finished = true;
			run.resolveCompletion?.();
		} finally {
			if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
			if (this.activeDispatch?.run === run) this.activeDispatch = null;
		}
	}

	async handleRunEvent(event) {
		const conversationId = String(event?.conversationId || "").trim();
		if (!conversationId) return;
		const eventAt = Number(event?.at || 0);

		if (event.type === "run_start") {
			const run = this.findRun(conversationId);
			if (run && !this.isStaleRunEvent(run, eventAt)) this.openRunTurn(run);
			return;
		}

		if (event.type === "message" && event.message) {
			const role = String(event.message.role || event.message.author || "").trim();
			let run = this.findRun(conversationId);
			// Shared conversations also carry the browser's own turns: ignore
			// events emitted before this Discord turn was dispatched.
			if (run && this.isStaleRunEvent(run, eventAt)) return;

			if (role === "user") {
				const text = extractAssistantContent(event.message);
				if (run && text && run.requestText && text.includes(run.requestText.trim())) {
					this.openRunTurn(run);
				}
				return;
			}
			if (role !== "assistant") return;

			const errorMessage = String(event.message.errorMessage || "").trim();
			if (errorMessage) this.noteRunError(conversationId, errorMessage);
			const activity = extractAssistantActivity(event.message);
			const content = extractAssistantContent(event.message);

			if (run) {
				if (content) run.accumulatedText += `${run.accumulatedText ? "\n" : ""}${content}`;
				// The trace records what the agent did: thinking and tool names.
				for (const item of activity) appendRunActivity(run, item);
				this.clearRunSettle(run);
				if (activity.length) this.scheduleLiveUpdate(run, this.getConfig());
			} else {
				const early = this.earlyRuns.get(conversationId) || { accumulatedText: "", firstAt: 0 };
				if (!early.firstAt) early.firstAt = eventAt;
				if (content) early.accumulatedText += `${early.accumulatedText ? "\n" : ""}${content}`;
				this.earlyRuns.set(conversationId, early);
			}
			return;
		}

		if (event.type !== "run_end") return;
		let run = this.findRun(conversationId);
		if (!run) {
			this.earlyRuns.delete(conversationId);
			this.runErrors.delete(conversationId);
			return;
		}
		if (this.isStaleRunEvent(run, eventAt)) return;
		run.stopReason = String(event?.stopReason || run.stopReason || "");
		// Our turn ended without text: give the transcript a moment, then report.
		if (run.sharedConversation && !run.accumulatedText) {
			this.scheduleRunSettle(run);
			return;
		}
		await this.finishRun(run);
	}

	/**
	 * Mark the start of the turn this Discord message triggered.
	 *
	 * A shared conversation also runs the browser tab's turns, so the output
	 * collected before our own turn began is dropped.
	 */
	openRunTurn(run) {
		if (!run || run.turnOpened) return;
		run.turnOpened = true;
		run.sawTurnStart = true;
		run.accumulatedText = "";
	}

	/** Find the run waiting for a conversation, including the in-flight dispatch. */
	findRun(conversationId) {
		const run = this.pendingRuns.get(conversationId);
		if (run) return run;
		if (this.activeDispatch?.run && !this.activeDispatch.run.finished) {
			this.activeDispatch.earlyConversationId = conversationId;
			return this.activeDispatch.run;
		}
		return null;
	}

	/** Whether a run event predates this Discord turn and must be ignored. */
	isStaleRunEvent(run, eventAt) {
		if (!run || !eventAt) return false;
		const dispatchedAt = Number(run.dispatchedAt || 0);
		if (!dispatchedAt) return false;
		return eventAt < dispatchedAt - EVENT_CLOCK_SKEW_MS;
	}

	/** Debounce the end of a shared-conversation turn. */
	scheduleRunSettle(run) {
		this.clearRunSettle(run);
		run.settleTimer = setTimeout(() => {
			run.settleTimer = null;
			void this.finishRun(run);
		}, SHARED_RUN_SETTLE_MS);
		run.settleTimer.unref?.();
	}

	/** Cancel a pending shared-conversation settle timer. */
	clearRunSettle(run) {
		if (!run?.settleTimer) return;
		clearTimeout(run.settleTimer);
		run.settleTimer = null;
	}

	async finishRun(run, { timedOut = false } = {}) {
		if (!run || run.finished) return;
		run.finished = true;
		if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
		this.clearRunSettle(run);
		if (run.conversationId) this.pendingRuns.delete(run.conversationId);
		this.earlyRuns.delete(run.conversationId);

		const generation = Number(this.userGenerations.get(run.authorId) || 0);
		if (!run.cancelled && generation === run.generation) {
			await this.deliverRun(run, { timedOut });
		} else {
			this.log("info", `Discord reply skipped for a reset or superseded conversation.`);
		}
		this.runErrors.delete(run.conversationId);
		run.resolveCompletion?.();
	}

	async deliverRun(run, { timedOut = false } = {}) {
		if (run.delivered) return;
		run.delivered = true;
		const config = this.getConfig();
		const showTrace = config.showToolCalls === true;
		let rawText = timedOut
			? "⏱️ Task timed out after 10 minutes."
			: showTrace
				? renderRunContent(run, { showTrace: true })
				: run.accumulatedText;
		if (!timedOut && !stripInternalMarkers(rawText)) {
			const recovered = await this.recoverRunText(run);
			const trace = showTrace ? renderRunContent(run, { showTrace: true }) : "";
			rawText = trace ? `${trace}\n${recovered}`.trim() : recovered;
		}
		const finalText = stripInternalMarkers(rawText) || this.describeEmptyRun(run);
		const chunks = chunkMarkdownText(finalText, DISCORD_MESSAGE_LIMIT);

		// A slash-command turn publishes through the interaction response: it is
		// the only surface a user-installed app may use in a third-party DM.
		if (run.interaction) {
			try {
				await this.sendInteractionContent(run.interaction, finalText, {
					edit: true,
					flags: this.promptInteractionFlags(run.interaction),
				});
				this.status.messagesReplied += 1;
				this.status.lastReplyAt = Date.now();
			} catch (error) {
				this.status.lastError = error?.message || String(error);
				this.log("warn", `Discord interaction reply delivery failed: ${this.status.lastError}`);
			}
			return;
		}

		// Streamed reply: the message already lives in the channel, so the
		// answer only has to be written into it.
		if (run.liveEnabled) {
			this.stopLiveUpdate(run);
			if (run.livePromise) await run.livePromise.catch(() => {});
			if (run.liveMessageId) {
				await this.finishLiveReply(run, config, finalText);
				return;
			}
		}

		try {
			for (let index = 0; index < chunks.length; index++) {
				const payload = { content: chunks[index] };
				if (index === 0 && run.replyToMessageId && run.isGuild !== false) {
					payload.message_reference = { message_id: run.replyToMessageId };
				}
				try {
					const message = await this.api(config.botToken, "POST", `/channels/${run.channelId}/messages`, payload);
					if (message?.id) this.rememberBotMessage(message);
				} catch (error) {
					// A stale or malformed reply reference must never swallow the
					// answer: post the same chunk again without the reference.
					if (index === 0 && payload.message_reference) {
						delete payload.message_reference;
						const message = await this.api(config.botToken, "POST", `/channels/${run.channelId}/messages`, payload);
						if (message?.id) this.rememberBotMessage(message);
					} else {
						throw error;
					}
				}
				this.status.messagesReplied += 1;
				this.status.lastReplyAt = Date.now();
			}
		} catch (error) {
			this.status.lastError = error?.message || String(error);
			this.log("warn", `Discord reply delivery failed: ${this.status.lastError}`);
		}
	}

	/** Post the live reply message (the first page of a streamed answer). */
	async postLiveMessage(run, config, content) {
		const payload = { content: String(content || "") };
		// DMs get plain messages: a reply reference in a DM is noise and can be
		// rejected by Discord. Guild channels keep the reply behaviour.
		if (!run.liveMessageId && run.replyToMessageId && run.isGuild !== false) {
			payload.message_reference = { message_id: run.replyToMessageId };
		}
		try {
			const message = await this.api(config.botToken, "POST", `/channels/${run.channelId}/messages`, payload);
			this.status.messagesReplied += 1;
			this.status.lastReplyAt = Date.now();
			if (message?.id) {
				run.liveMessageId = String(message.id);
				this.rememberBotMessage(message);
			}
			return message;
		} catch (error) {
			// A stale or malformed reply reference must never swallow the answer.
			if (payload.message_reference) {
				delete payload.message_reference;
				const message = await this.api(config.botToken, "POST", `/channels/${run.channelId}/messages`, payload);
				this.status.messagesReplied += 1;
				this.status.lastReplyAt = Date.now();
				if (message?.id) {
					run.liveMessageId = String(message.id);
					this.rememberBotMessage(message);
				}
				return message;
			}
			throw error;
		}
	}

	/** Post or edit the live Discord message with the current run view. */
	async flushLiveUpdate(run, config) {
		if (!run?.liveEnabled) return;
		const promise = this.updateLiveMessage(run, config);
		run.livePromise = promise;
		try {
			await promise;
		} finally {
			if (run.livePromise === promise) run.livePromise = null;
		}
	}

	/** Write the current run view into the live Discord message. */
	async updateLiveMessage(run, config) {
		if (!run?.liveEnabled) return;
		const showTrace = config.showToolCalls === true;
		const rendered = renderRunContent(run, { showTrace });
		const content = rendered || "⏳ Working…";
		try {
			if (!run.liveMessageId) {
				const message = await this.postLiveMessage(run, config, content);
				run.liveMessageId = String(message?.id || "");
				run.livePageStart = 0;
				run.liveRenderedLength = rendered.length;
				return;
			}
			const page = content.slice(Number(run.livePageStart || 0));
			if (page.length <= DISCORD_MESSAGE_LIMIT) {
				await this.api(config.botToken, "PATCH", `/channels/${run.channelId}/messages/${run.liveMessageId}`, {
					content: page || "⏳ Working…",
				});
				run.liveRenderedLength = rendered.length;
				return;
			}
			// The page is full: keep what fits and continue in the next message.
			const cut = findLiveCut(page, DISCORD_MESSAGE_LIMIT);
			await this.api(config.botToken, "PATCH", `/channels/${run.channelId}/messages/${run.liveMessageId}`, {
				content: page.slice(0, cut),
			});
			const next = await this.postLiveMessage(run, config, page.slice(cut));
			run.liveMessageId = String(next?.id || "");
			run.livePageStart = Number(run.livePageStart || 0) + cut;
			run.liveRenderedLength = rendered.length;
		} catch (error) {
			this.status.lastError = error?.message || String(error);
			this.log("warn", `Discord live update failed: ${this.status.lastError}`);
		}
	}

	/** Update the live reply, throttled to the Discord edit rate limit. */
	scheduleLiveUpdate(run, config) {
		if (!run?.liveEnabled) return;
		if (run.liveTimer) return;
		const elapsed = Date.now() - Number(run.liveUpdatedAt || 0);
		const wait = Math.max(0, LIVE_EDIT_MIN_INTERVAL_MS - elapsed);
		if (wait === 0) {
			run.liveUpdatedAt = Date.now();
			void this.flushLiveUpdate(run, config);
			return;
		}
		run.liveTimer = setTimeout(() => {
			run.liveTimer = null;
			run.liveUpdatedAt = Date.now();
			void this.flushLiveUpdate(run, config);
		}, wait);
		run.liveTimer.unref?.();
	}

	/** Finish a streamed reply: the message already exists, so only edit it. */
	async finishLiveReply(run, config, finalText) {
		const content = String(finalText || "").trim() || "✅ Task completed.";
		const rendered = renderRunContent(run, { showTrace: config.showToolCalls === true });
		const aligned = content.startsWith(rendered) && rendered.length >= Number(run.liveRenderedLength || 0);
		if (!aligned) run.livePageStart = 0;
		const page = content.slice(Number(run.livePageStart || 0));
		try {
			if (page.length <= DISCORD_MESSAGE_LIMIT) {
				await this.api(config.botToken, "PATCH", `/channels/${run.channelId}/messages/${run.liveMessageId}`, {
					content: page,
				});
				return;
			}
			const cut = findLiveCut(page, DISCORD_MESSAGE_LIMIT);
			await this.api(config.botToken, "PATCH", `/channels/${run.channelId}/messages/${run.liveMessageId}`, {
				content: page.slice(0, cut),
			});
			const next = await this.postLiveMessage(run, config, page.slice(cut));
			run.liveMessageId = String(next?.id || "");
			run.livePageStart = Number(run.livePageStart || 0) + cut;
		} catch (error) {
			this.status.lastError = error?.message || String(error);
			this.log("warn", `Discord live reply delivery failed: ${this.status.lastError}`);
		}
	}

	/** Stop a pending live edit so it cannot overwrite the final answer. */
	stopLiveUpdate(run) {
		if (run?.liveTimer) {
			clearTimeout(run.liveTimer);
			run.liveTimer = null;
		}
	}

	/**
	 * Download the attachments of a Discord message and describe them.
	 *
	 * Opt-in: without `allowAttachments` the files are never fetched.
	 */
	async collectAttachmentContext(message, { config = this.getConfig(), authorId = "" } = {}) {
		if (config?.allowAttachments !== true) return "";
		const items = collectMessageAttachments(message);
		if (!items.length) return "";
		const workspace = await this.resolveWorkspace(authorId, config);
		const { downloaded, skipped } = await this.downloadAttachments(items, {
			workspace,
			messageId: String(message?.id || ""),
		});
		return buildAttachmentContext(downloaded, skipped);
	}

	/** Download the attachments of a Discord message into the workspace. */
	async downloadAttachments(items, { workspace, messageId } = {}) {
		const downloaded = [];
		const skipped = [];
		const root = workspace ? resolve(workspace) : "";
		if (!root) return { downloaded, skipped: items };
		for (const item of items) {
			if (!isSupportedAttachmentType(item.contentType, item.filename)) {
				skipped.push(item);
				continue;
			}
			if (Number(item.size || 0) > MAX_ATTACHMENT_BYTES) {
				skipped.push(item);
				continue;
			}
			try {
				const path = await this.fetchAttachment(item, { root, messageId });
				downloaded.push({ ...item, path });
			} catch (error) {
				this.log("warn", `Discord attachment download failed: ${error?.message || error}`);
				skipped.push(item);
			}
		}
		return { downloaded, skipped };
	}

	/** Fetch one attachment and store it inside the workspace. */
	async fetchAttachment(item, { root, messageId }) {
		const response = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("attachment exceeds the size limit");
		const dir = join(root, ATTACHMENT_DIR, String(messageId || "unknown"));
		await this.fs.mkdir(dir, { recursive: true });
		const path = join(dir, safeAttachmentName(item.filename));
		await this.fs.writeFile(path, buffer);
		await this.pruneAttachments(root);
		return path;
	}

	/** Remove attachment folders that are older than the retention window. */
	async pruneAttachments(root) {
		try {
			const base = join(root, ATTACHMENT_DIR);
			const entries = await this.fs.readdir(base, { withFileTypes: true });
			const now = Date.now();
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dir = join(base, entry.name);
				const stat = await this.fs.stat(dir);
				if (now - Number(stat.mtimeMs || 0) > ATTACHMENT_TTL_MS) {
					await this.fs.rm(dir, { recursive: true, force: true });
				}
			}
		} catch {
			/* pruning is best effort */
		}
	}

	/** Wait briefly for a late assistant message before giving up on the text. */
	async waitForRunText(run, timeoutMs = LATE_TEXT_GRACE_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const text = stripInternalMarkers(run?.accumulatedText || "");
			if (text) return text;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return stripInternalMarkers(run?.accumulatedText || "");
	}

	/**
	 * Recover the assistant text when no `message` event carried it.
	 *
	 * The host transcript is the source of truth, so read the finished turn back
	 * from the conversation instead of reporting an empty completion.
	 */
	async recoverRunText(run) {
		const late = await this.waitForRunText(run);
		if (late) return late;
		const conversationId = String(run?.conversationId || "").trim();
		if (!conversationId) return "";
		const since = Number(run?.startedAt || 0);
		try {
			const snapshot = await this.host?.conversations?.get?.(conversationId);
			const text = extractLastAssistantText(snapshot, { since });
			if (text) return text;
		} catch (error) {
			this.log("warn", `Conversation transcript lookup failed: ${error?.message || error}`);
		}
		// Headless runs live in the plugin's own pseudo client: read that
		// snapshot directly, the host only exposes it per client id.
		const clientId =
			String(run?.clientId || "").trim() ||
			(run?.accountId ? `plugin:discord:${run.accountId}` : "");
		if (clientId) {
			try {
				const snapshot = await this.host?.getActiveConversation?.({ clientId });
				const text = extractLastAssistantText(snapshot, { since });
				if (text) return text;
			} catch (error) {
				this.log("warn", `Client transcript lookup failed: ${error?.message || error}`);
			}
		}
		return "";
	}

	/** Explain a run that finished without any assistant text. */
	describeEmptyRun(run) {
		const error = String(run?.lastError || this.runErrors.get(run?.conversationId) || "").trim();
		if (error) return `⚠️ The task failed: ${error}`;
		const reason = String(run?.stopReason || "").trim();
		if (reason && !["stop", "endTurn", "end_turn"].includes(reason)) {
			return `⚠️ The task finished without text output (stop reason: ${reason}).`;
		}
		return "✅ Task completed, but the agent returned no text for this turn.";
	}

}

/** Activate the plugin in pi-web-ui. */
export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	if (!savedSecrets[SECRET_BOT_TOKEN] && host.secrets?.get) {
		savedSecrets[SECRET_BOT_TOKEN] = (await host.secrets.get(SECRET_BOT_TOKEN)) || "";
	}
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const initialUserWorkspaces = (await host.storage.get("userWorkspaces")) || {};
	const initialUserContexts = (await host.storage.get("userContexts")) || {};
	const bridge = new DiscordBotBridge({
		host,
		getConfig: () => localConfig,
		updateConfig: async (patch) => {
			localConfig = { ...localConfig, ...(patch || {}) };
			await host.storage.set("config", stripSecretsFromConfig(localConfig));
		},
		persistUserWorkspaces: async (workspaces) => {
			await host.storage.set("userWorkspaces", workspaces || {});
		},
		persistUserContexts: async (contexts) => {
			await host.storage.set("userContexts", contexts || {});
		},
		initialUserWorkspaces,
		initialUserContexts,
		log: (level, message) => host.log?.(level, message),
	});

	if (localConfig.botEnabled && localConfig.botToken) {
		void bridge.start().catch((error) => {
			host.log?.("warn", `Discord bot auto-start note: ${error?.message || error}`);
		});
	}

	const discordTool = {
		name: "discord",
		description: "Send a Discord message or inspect the Discord bot connection status.",
		promptSnippet: "send Discord messages or inspect bot status",
		promptGuidelines: [
			"Confirm the target channel ID and message text with the user before sending.",
			"Use action=status to inspect the Discord Gateway connection.",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "send a message or inspect bot status.",
				},
				channel_id: {
					type: "string",
					description: "Target Discord channel ID for action=send.",
				},
				text: {
					type: "string",
					description: "Message content for action=send.",
				},
			},
			required: ["action"],
		},
		/**
		 * pi-web-ui invokes agent tools as `execute(toolCallId, params, signal, onUpdate)`,
		 * so the parameter object arrives as the second argument. Accept the legacy
		 * single-argument form too, so a direct `execute(params)` call still works.
		 */
		async execute(toolCallId, params) {
			const args =
				params && typeof params === "object"
					? params
					: toolCallId && typeof toolCallId === "object"
						? toolCallId
						: {};
			const action = String(args.action || "");
			if (action === "send") {
				const channelId = String(args.channel_id || "").trim() || String(localConfig.defaultChannelId || "").trim();
				if (!channelId) throw new Error("channel_id is required.");
				if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
				const result = await discordApi(
					localConfig.botToken,
					"POST",
					`/channels/${channelId}/messages`,
					{ content: String(args.text || "") },
				);
				return JSON.stringify(result, null, 2);
			}
			if (action === "status") return JSON.stringify(bridge.getStatus(), null, 2);
			throw new Error(`Unknown Discord tool action: ${action}`);
		},
	};

	const registerTool = host.registerAgentTool || host.registerTool;
	const unregisterTool = registerTool?.call(host, discordTool) || null;

	const unregisterClientMessage = host.onClientMessage?.(async (message, reply) => {
		const respond = (payload) =>
			reply({
				...(payload || {}),
				...(message?.__rid ? { __rid: message.__rid } : {}),
				...(message?.requestId ? { requestId: message.requestId } : {}),
			});
		try {
			switch (message?.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					respond({
						type: "state",
						config: {
							defaultChannelId: localConfig.defaultChannelId || "",
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							systemPrompt: localConfig.systemPrompt || "",
							systemPromptMode: localConfig.systemPromptMode || "",
							autoReplyEnabled: Boolean(localConfig.autoReplyEnabled),
							autoReplyChannels: normalizeAutoReplyChannels(localConfig.autoReplyChannels),
							showToolCalls: Boolean(localConfig.showToolCalls),
							liveReplyEnabled: Boolean(localConfig.liveReplyEnabled),
							allowAttachments: Boolean(localConfig.allowAttachments),
							useWorkspaceSession: localConfig.useWorkspaceSession !== false,
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: normalizeAllowedUsers(localConfig.allowedUsers),
							hasBotToken: Boolean(secrets[SECRET_BOT_TOKEN] || localConfig.botToken),
						},
						botStatus: bridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = message.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					if (host.secrets) {
						if (localConfig.botToken) {
							await host.secrets.set(SECRET_BOT_TOKEN, localConfig.botToken);
						} else if (incoming.clearBotToken) {
							await host.secrets.delete?.(SECRET_BOT_TOKEN);
						}
					}
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					if (localConfig.botEnabled && localConfig.botToken) {
						await bridge.stop().catch(() => {});
						await bridge.start().catch(() => {});
					} else {
						await bridge.stop().catch(() => {});
					}
					respond({ type: "save_config_done", success: true, botStatus: bridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = message.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					if (!testConfig.botToken) {
						respond({ type: "test_config_done", success: false, message: "Bot Token is not configured." });
						break;
					}
					try {
						const bot = await discordApi(testConfig.botToken, "GET", "/users/@me", null, { timeoutMs: 10_000 });
						respond({
							type: "test_config_done",
							success: true,
							message: `Connection successful: @${bot.username} (ID: ${bot.id})`,
						});
					} catch (error) {
						respond({
							type: "test_config_done",
							success: false,
							message: `Connection failed: ${error?.message || error}`,
						});
					}
					break;
				}

				case "send_message": {
					const channelId = String(message.channelId || "").trim() || String(localConfig.defaultChannelId || "").trim();
					if (!channelId) throw new Error("channelId is required.");
					if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
					const result = await discordApi(
						localConfig.botToken,
						"POST",
						`/channels/${channelId}/messages`,
						{ content: String(message.text || "") },
					);
					respond({ type: "send_done", success: true, result });
					break;
				}

				case "start_bot": {
					if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await bridge.start();
					respond({ type: "bot_status", success: true, status: bridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await bridge.stop();
					respond({ type: "bot_status", success: true, status: bridge.getStatus() });
					break;
				}

				default:
					respond({ type: "error", message: `Unknown message type: ${message?.type}` });
					break;
			}
		} catch (error) {
			respond({ type: "error", message: error?.message || String(error) });
		}
	});

	return async () => {
		unregisterClientMessage?.();
		await bridge.stop().catch(() => {});
		try {
			unregisterTool?.();
		} catch {}
	};
}
