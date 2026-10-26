/**
 * pi-web-ui Discord plugin
 *
 * A zero-dependency Discord bot bridge for pi-web-ui. It uses Discord's
 * outbound Gateway WebSocket, native guild application commands, interaction
 * callbacks, and per-user isolated pi-web-ui sessions.
 */

import { createHash } from "node:crypto";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_BOT_TOKEN = "discord.botToken";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

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

export const INTERACTION_RESPONSE_TYPE = Object.freeze({
	PONG: 1,
	CHANNEL_MESSAGE_WITH_SOURCE: 4,
	DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
	APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
});

export const DISCORD_EPHEMERAL_FLAG = 64;
export const DISCORD_MESSAGE_LIMIT = 1950;
export const DISCORD_AUTOCOMPLETE_LIMIT = 25;

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
		name: "clear",
		description: "Clear the current Discord conversation context",
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
		description: "Show or change the AI model used by Discord",
		type: 1,
		options: Object.freeze([
			Object.freeze({
				name: "model",
				description: "Model ID in provider/model form (leave empty to show the current one)",
				type: 3,
				required: false,
				autocomplete: true,
			}),
		]),
	}),
]);

const LEGACY_COMMAND_ALIASES = Object.freeze({
	workspace: "cwd",
});

const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
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
		"User-Agent": "DiscordBot (pi-web-ui-discord-plugin, 1.0.0)",
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
		throw new Error(body.message || `Discord HTTP ${response.status}`);
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
		log,
		api,
		fsImpl,
		webSocketFactory,
	} = {}) {
		this.host = host;
		this.getConfig = getConfig || (() => ({}));
		this.updateConfig = updateConfig || (async () => {});
		this.persistUserWorkspaces = persistUserWorkspaces || (async () => {});
		this.log = log || ((level, message) => console.log(`[discord-bot:${level}] ${message}`));
		this.api = api || discordApi;
		this.fs = fsImpl || { readdir: fsReaddir, stat: fsStat };
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
		this.userConversations = new Map();
		this.userWorkspaces = new Map(Object.entries(initialUserWorkspaces || {}));
		this.userGenerations = new Map();
		this.knownGuilds = new Set();
		this.registeredGuilds = new Set();
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
		};
	}

	getStatus() {
		return {
			...this.status,
			registeredGuilds: [...this.registeredGuilds].sort(),
			knownGuilds: [...this.knownGuilds].sort(),
			activeRuns: this.pendingRuns.size,
		};
	}

	resolveWorkspace(authorId, config = this.getConfig()) {
		return String(this.userWorkspaces.get(authorId) || config?.workspace || this.host?.cwd || "").trim();
	}

	/** Stable per-user account ID; the generation changes after an explicit reset. */
	userAccountId(authorId) {
		const generation = Number(this.userGenerations.get(authorId) || 0);
		const base = peerAccountId(authorId);
		return generation > 0 ? `${base}_g${generation}` : base;
	}

	/** Drop the remembered conversation and force the next prompt onto a blank pseudo client. */
	resetUserConversation(authorId) {
		const generation = Number(this.userGenerations.get(authorId) || 0) + 1;
		this.userGenerations.set(authorId, generation);
		this.userConversations.delete(authorId);
		for (const run of this.pendingRuns.values()) {
			if (run.authorId === authorId) run.cancelled = true;
		}
		return this.userAccountId(authorId);
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
		ws.onclose = () => {
			this.status.connected = false;
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
		try {
			const registered = await this.api(
				token,
				"PUT",
				`/applications/${applicationId}/guilds/${id}/commands`,
				DISCORD_COMMANDS,
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

	async deferInteraction(interaction) {
		await this.respondToInteraction(interaction, {
			type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
			data: { flags: DISCORD_EPHEMERAL_FLAG },
		});
	}

	async editInteractionResponse(interaction, content) {
		const applicationId = String(interaction?.application_id || this.applicationId || "").trim();
		if (!applicationId) throw new Error("Discord application ID is unavailable.");
		return this.api(
			this.getConfig().botToken,
			"PATCH",
			`/webhooks/${applicationId}/${interaction.token}/messages/@original`,
			{ content, flags: DISCORD_EPHEMERAL_FLAG },
		);
	}

	async handleApplicationCommand(interaction) {
		const authorId = String(interaction?.member?.user?.id || interaction?.user?.id || "").trim();
		const config = this.getConfig();
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

		let deferred = false;
		try {
			await this.deferInteraction(interaction);
			deferred = true;
		} catch (error) {
			this.log("warn", `Discord interaction defer failed: ${error?.message || error}`);
		}

		const name = String(interaction?.data?.name || "").toLowerCase();
		let args = "";
		if (name === "cwd") args = interactionOption(interaction, "path");
		if (name === "model") args = interactionOption(interaction, "model");

		try {
			const content = await this.executeCommand(name, args, { authorId, config });
			const finalContent = content || `Unknown command: /${name}`;
			if (deferred) await this.editInteractionResponse(interaction, finalContent);
			else {
				await this.respondToInteraction(interaction, {
					type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: finalContent, flags: DISCORD_EPHEMERAL_FLAG },
				});
			}
		} catch (error) {
			const finalContent = `Command failed: ${error?.message || error}`;
			if (deferred) {
				await this.editInteractionResponse(interaction, finalContent).catch(() => {});
			} else {
				await this.respondToInteraction(interaction, {
					type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: finalContent, flags: DISCORD_EPHEMERAL_FLAG },
				}).catch(() => {});
			}
		}
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
				const root = this.resolveWorkspace(authorId, config);
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

	async executeCommand(name, args = "", { authorId = "", config = this.getConfig() } = {}) {
		const command = String(name || "").toLowerCase();
		const argument = String(args || "").trim();

		if (command === "help") {
			return [
				"### pi-web-ui Discord bot",
				"- Send a message to start a multi-turn conversation with the pi agent.",
				"- `/help` — show this help.",
				"- `/status` — show gateway, counters, and command registration status.",
				"- `/new` — start a fresh conversation.",
				"- `/clear` — clear the current conversation context (alias of `/new`).",
				"- `/cwd [path]` — show or change the workspace directory.",
				"- `/model [provider/model]` — show or change the AI model.",
				"",
				"Native slash commands are registered per guild. Plain-text commands remain supported.",
			].join("\n");
		}

		if (command === "status") {
			const status = this.getStatus();
			const guilds = status.registeredGuilds.length
				? status.registeredGuilds.join(", ")
				: "none yet";
			return [
				"### Discord bot status",
				`- Bot: @${status.botUsername || "not connected"}`,
				`- Gateway: ${status.state}`,
				`- Application ID: ${status.applicationId || "unknown"}`,
				`- Native commands registered: ${status.registeredCommands}`,
				`- Guilds with registered commands: ${guilds}`,
				`- Messages received: ${status.messagesReceived}`,
				`- Replies sent: ${status.messagesReplied}`,
			].join("\n");
		}

		if (command === "new" || command === "clear") {
			this.resetUserConversation(authorId);
			return "✨ Conversation context cleared. A fresh session is ready.";
		}

		if (command === "cwd") {
			if (!argument) {
				const workspace = this.resolveWorkspace(authorId, config) || "(host default)";
				return `📂 Current workspace: ${workspace}\nUse \`/cwd <path>\` to switch directories.`;
			}
			const currentRoot = this.resolveWorkspace(authorId, config) || this.host?.cwd || process.cwd();
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
			this.resetUserConversation(authorId);
			return `📂 Workspace changed to: ${targetPath}\n✨ A fresh session was created for the new workspace.`;
		}

		if (command === "model") {
			if (!argument) {
				const currentModel = config.model || "(host default)";
				const currentThinking = config.thinkingLevel || "(host default)";
				return [
					"### Current AI configuration",
					`- Model: \`${currentModel}\``,
					`- Thinking level: \`${currentThinking}\``,
					"Use `/model provider/model` to change the model.",
				].join("\n");
			}
			const catalog = await this.getModelCatalog();
			if (catalog.length > 0 && !catalog.includes(argument)) {
				return `❌ Unknown model: ${argument}\nUse the autocomplete list or check the configured model IDs.`;
			}
			await this.updateConfig({ model: argument });
			return `✨ AI model changed to: ${argument}`;
		}

		return null;
	}

	async onInboundMessage(message) {
		if (!message || message.author?.bot) return;

		const channelId = String(message.channel_id || "").trim();
		const authorId = String(message.author?.id || "").trim();
		const botId = String(this.botUser?.id || "").trim();
		const isGuild = Boolean(message.guild_id);

		if (isGuild && botId) {
			const mentions = Array.isArray(message.mentions) ? message.mentions : [];
			if (!mentions.some((user) => String(user?.id || "") === botId)) return;
		}

		const cleanText = extractDiscordText(message, botId);
		if (!cleanText) return;

		const config = this.getConfig();
		if (!isAllowedUser(config, authorId)) {
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content: "Access denied. Add your Discord User ID to the bot allowlist in pi-web-ui.",
				message_reference: { message_id: message.id },
			}).catch(() => {});
			return;
		}

		this.status.messagesReceived += 1;
		this.status.lastMessageAt = Date.now();

		const parsed = parseLegacyCommand(cleanText);
		if (parsed && DISCORD_COMMANDS.some((command) => command.name === parsed.name)) {
			await this.handleLegacyCommand(parsed, { channelId, authorId, replyToId: message.id, config });
			return;
		}

		void this.api(config.botToken, "POST", `/channels/${channelId}/typing`, null).catch(() => {});

		const accountId = this.userAccountId(authorId);
		const generation = Number(this.userGenerations.get(authorId) || 0);
		const run = {
			channelId,
			authorId,
			replyToMessageId: message.id,
			accumulatedText: "",
			startedAt: Date.now(),
			generation,
			cancelled: false,
			finished: false,
			delivered: false,
			conversationId: "",
			resolveCompletion: null,
			timeoutTimer: null,
		};
		const completion = new Promise((resolve) => {
			run.resolveCompletion = resolve;
		});
		run.completion = completion;

		const request = { text: cleanText, accountId };
		const workspace = this.resolveWorkspace(authorId, config);
		if (workspace) request.cwd = workspace;
		if (config.model) request.model = config.model;
		if (config.thinkingLevel) request.thinkingLevel = config.thinkingLevel;

		await this.enqueueDispatch(run, request);
	}

	async handleLegacyCommand(parsed, { channelId, authorId, replyToId, config }) {
		try {
			const content = await this.executeCommand(parsed.name, parsed.args, { authorId, config });
			if (content === null) return false;
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content,
				message_reference: replyToId ? { message_id: replyToId } : undefined,
			});
			return true;
		} catch (error) {
			await this.api(config.botToken, "POST", `/channels/${channelId}/messages`, {
				content: `Command failed: ${error?.message || error}`,
				message_reference: replyToId ? { message_id: replyToId } : undefined,
			}).catch(() => {});
			return true;
		}
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

		try {
			const dispatched = await this.host.chat(request);
			const conversationId = String(dispatched?.conversationId || "").trim();
			const expectedClientId = `plugin:discord:${request.accountId}`;
			if (dispatched?.clientId && dispatched.clientId !== expectedClientId) {
				throw new Error(
					`pi-web-ui routed the request to ${dispatched.clientId} instead of ${expectedClientId}`,
				);
			}
			if (!conversationId) throw new Error("pi-web-ui did not return a conversation ID");

			run.conversationId = conversationId;
			this.userConversations.set(run.authorId, conversationId);
			if (!run.finished) this.pendingRuns.set(conversationId, run);

			const early = this.earlyRuns.get(conversationId);
			if (early?.accumulatedText && !run.accumulatedText) {
				run.accumulatedText = early.accumulatedText;
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

		if (event.type === "message" && event.message) {
			const content = extractAssistantContent(event.message);
			const isAssistant = event.message.role === "assistant" || event.message.author === "assistant";
			if (!content || !isAssistant) return;

			let run = this.pendingRuns.get(conversationId);
			if (!run && this.activeDispatch?.run && !this.activeDispatch.run.finished) {
				run = this.activeDispatch.run;
				this.activeDispatch.earlyConversationId = conversationId;
			}
			if (run) {
				run.accumulatedText += `${run.accumulatedText ? "\n" : ""}${content}`;
			} else {
				const early = this.earlyRuns.get(conversationId) || { accumulatedText: "" };
				early.accumulatedText += `${early.accumulatedText ? "\n" : ""}${content}`;
				this.earlyRuns.set(conversationId, early);
			}
			return;
		}

		if (event.type !== "run_end") return;
		let run = this.pendingRuns.get(conversationId);
		if (!run && this.activeDispatch?.run && !this.activeDispatch.run.finished) {
			run = this.activeDispatch.run;
			this.activeDispatch.earlyConversationId = conversationId;
		}
		if (!run) {
			this.earlyRuns.delete(conversationId);
			return;
		}
		await this.finishRun(run);
	}

	async finishRun(run, { timedOut = false } = {}) {
		if (!run || run.finished) return;
		run.finished = true;
		if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
		if (run.conversationId) this.pendingRuns.delete(run.conversationId);
		this.earlyRuns.delete(run.conversationId);

		const generation = Number(this.userGenerations.get(run.authorId) || 0);
		if (!run.cancelled && generation === run.generation) {
			await this.deliverRun(run, { timedOut });
		} else {
			this.log("info", `Discord reply skipped for a reset or superseded conversation.`);
		}
		run.resolveCompletion?.();
	}

	async deliverRun(run, { timedOut = false } = {}) {
		if (run.delivered) return;
		run.delivered = true;
		const rawText = timedOut ? "⏱️ Task timed out after 10 minutes." : run.accumulatedText;
		const finalText = stripInternalMarkers(rawText) || "✅ Task completed (no text output).";
		const chunks = chunkMarkdownText(finalText, DISCORD_MESSAGE_LIMIT);
		const config = this.getConfig();

		try {
			for (let index = 0; index < chunks.length; index++) {
				const payload = { content: chunks[index] };
				if (index === 0 && run.replyToMessageId) {
					payload.message_reference = { message_id: run.replyToMessageId };
				}
				await this.api(config.botToken, "POST", `/channels/${run.channelId}/messages`, payload);
				this.status.messagesReplied += 1;
				this.status.lastReplyAt = Date.now();
			}
		} catch (error) {
			this.status.lastError = error?.message || String(error);
			this.log("warn", `Discord reply delivery failed: ${this.status.lastError}`);
		}
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
		initialUserWorkspaces,
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
		async execute(args) {
			const action = String(args?.action || "");
			if (action === "send") {
				const channelId = String(args?.channel_id || "").trim() || String(localConfig.defaultChannelId || "").trim();
				if (!channelId) throw new Error("channel_id is required.");
				if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
				const result = await discordApi(
					localConfig.botToken,
					"POST",
					`/channels/${channelId}/messages`,
					{ content: String(args?.text || "") },
				);
				return JSON.stringify(result, null, 2);
			}
			if (action === "status") return JSON.stringify(bridge.getStatus(), null, 2);
			throw new Error(`Unknown Discord tool action: ${action}`);
		},
	};

	const registerTool = host.registerAgentTool || host.registerTool;
	const unregisterTool = registerTool?.call(host, discordTool) || null;

	host.onClientMessage?.(async (message, reply) => {
		try {
			switch (message?.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							defaultChannelId: localConfig.defaultChannelId || "",
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
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
					reply({ type: "save_config_done", success: true, botStatus: bridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = message.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					if (!testConfig.botToken) {
						reply({ type: "test_config_done", success: false, message: "Bot Token is not configured." });
						break;
					}
					try {
						const bot = await discordApi(testConfig.botToken, "GET", "/users/@me", null, { timeoutMs: 10_000 });
						reply({
							type: "test_config_done",
							success: true,
							message: `Connection successful: @${bot.username} (ID: ${bot.id})`,
						});
					} catch (error) {
						reply({
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
					reply({ type: "send_done", success: true, result });
					break;
				}

				case "start_bot": {
					if (!localConfig.botToken) throw new Error("Discord Bot Token is not configured.");
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await bridge.start();
					reply({ type: "bot_status", success: true, status: bridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await bridge.stop();
					reply({ type: "bot_status", success: true, status: bridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", message: `Unknown message type: ${message?.type}` });
					break;
			}
		} catch (error) {
			reply({ type: "error", message: error?.message || String(error) });
		}
	});

	return async () => {
		await bridge.stop().catch(() => {});
		try {
			unregisterTool?.();
		} catch {}
	};
}
