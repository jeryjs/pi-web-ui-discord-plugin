import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import activate, {
	DISCORD_COMMANDS,
	DISCORD_GATEWAY_INTENTS,
	DISCORD_READ_DEFAULT_COUNT,
	DISCORD_READ_MAX_COUNT,
	INTERACTION_RESPONSE_TYPE,
	INTERACTION_TYPE,
	DiscordBotBridge,
	buildDirectoryChoices,
	extractDiscordText,
	formatChannelContext,
	formatChannelTranscript,
	isAllowedUser,
	mergeSavedSecrets,
	normalizeReadCount,
	parseLegacyCommand,
	peerAccountId,
	stripInternalMarkers,
	stripSecretsFromConfig,
} from "../index.mjs";

const AUTHOR_ID = "401364668204099585";
const BOT_ID = "999999999999999999";
const CHANNEL_ID = "1031955437005848616";

function baseConfig(overrides = {}) {
	return {
		botToken: "test-token",
		botEnabled: true,
		allowedUsers: [AUTHOR_ID],
		defaultChannelId: CHANNEL_ID,
		workspace: "/home/jery",
		model: "",
		thinkingLevel: "",
		...overrides,
	};
}

function createHarness({ config = baseConfig(), models = [], hostChat, fsImpl } = {}) {
	const apiCalls = [];
	const chatCalls = [];
	let bridge;
	const host = {
		cwd: "/home/jery",
		models: { list: () => models },
		onRunEvent: () => () => {},
		chat: async (request) => {
			chatCalls.push(request);
			if (hostChat) return hostChat(request, bridge);
			return {
				conversationId: "c1",
				clientId: `plugin:discord:${request.accountId}`,
			};
		},
	};
	const api = async (token, method, path, payload) => {
		apiCalls.push({ token, method, path, payload });
		if (method === "PUT") return DISCORD_COMMANDS;
		return { id: "message-1" };
	};
	bridge = new DiscordBotBridge({
		host,
		getConfig: () => config,
		updateConfig: async (patch) => Object.assign(config, patch),
		api,
		fsImpl,
		log: () => {},
	});
	bridge.botUser = { id: BOT_ID, username: "Nero" };
	return { bridge, apiCalls, chatCalls, config, host };
}

function message(text, overrides = {}) {
	return {
		id: "user-message-1",
		channel_id: CHANNEL_ID,
		author: { id: AUTHOR_ID, bot: false },
		content: text,
		mentions: [],
		...overrides,
	};
}

test("utility helpers preserve Discord routing and command compatibility", () => {
	assert.equal(peerAccountId("123"), peerAccountId("123"));
	assert.notEqual(peerAccountId("123"), peerAccountId("124"));
	assert.equal(extractDiscordText({ content: `<@!${BOT_ID}> hello` }, BOT_ID), "hello");
	assert.equal(stripInternalMarkers("hello [[notify:info:hidden]] world"), "hello world");
	assert.deepEqual(parseLegacyCommand("/workspace /tmp/project"), {
		name: "cwd",
		rawName: "workspace",
		args: "/tmp/project",
	});
	assert.deepEqual(parseLegacyCommand("/MODEL openai/gpt-5"), {
		name: "model",
		rawName: "model",
		args: "openai/gpt-5",
	});
	assert.equal(parseLegacyCommand("not a command"), null);
	assert.equal(isAllowedUser({ allowedUsers: [] }, AUTHOR_ID), true);
	assert.equal(isAllowedUser({ allowedUsers: [AUTHOR_ID] }, AUTHOR_ID), true);
	assert.equal(isAllowedUser({ allowedUsers: ["someone-else"] }, AUTHOR_ID), false);
});

test("configuration helpers keep the bot token out of plaintext storage", () => {
	const merged = mergeSavedSecrets(
		{ botToken: "", defaultChannelId: "42" },
		{ botToken: "old-token", workspace: "/tmp" },
		{ "discord.botToken": "encrypted-token" },
	);
	assert.equal(merged.botToken, "encrypted-token");
	assert.equal(merged.defaultChannelId, "42");
	assert.equal(merged.workspace, "/tmp");
	assert.equal(stripSecretsFromConfig(merged).botToken, undefined);
});

test("native command definitions include all required commands and autocomplete options", () => {
	assert.deepEqual(
		DISCORD_COMMANDS.map((command) => command.name),
		["help", "status", "new", "clear", "cancel", "cwd", "model", "thinking", "system", "context", "read", "pi", "pi-message"],
	);
	const cwd = DISCORD_COMMANDS.find((command) => command.name === "cwd");
	const model = DISCORD_COMMANDS.find((command) => command.name === "model");
	const thinking = DISCORD_COMMANDS.find((command) => command.name === "thinking");
	const system = DISCORD_COMMANDS.find((command) => command.name === "system");
	assert.equal(cwd.options[0].autocomplete, true);
	assert.equal(cwd.options[0].name, "path");
	assert.equal(model.options[0].autocomplete, true);
	assert.equal(model.options[0].name, "model");
	assert.deepEqual(
		thinking.options[0].choices.map((choice) => choice.value),
		["off", "low", "medium", "high", "max"],
	);
	assert.deepEqual(
		system.options.map((option) => option.name),
		["replace", "append"],
	);
	for (const option of system.options) {
		assert.equal(option.required, false);
	}

	const context = DISCORD_COMMANDS.find((command) => command.name === "context");
	assert.equal(context.type, 1);
	assert.deepEqual(
		context.options.map((option) => option.name),
		["action"],
	);
	assert.deepEqual(
		context.options[0].choices.map((choice) => choice.value),
		["show", "clear"],
	);

	const read = DISCORD_COMMANDS.find((command) => command.name === "read");
	assert.equal(read.type, 1);
	assert.equal(read.options[0].name, "count");
	assert.equal(read.options[0].type, 4);
	assert.equal(read.options[0].required, false);
	assert.equal(read.options[0].min_value, 1);
	assert.equal(read.options[0].max_value, DISCORD_READ_MAX_COUNT);

	const pi = DISCORD_COMMANDS.find((command) => command.name === "pi");
	assert.equal(pi.type, 1);
	assert.deepEqual(
		pi.options.map((option) => option.name),
		["message", "context"],
	);
	// Discord requires required options to be listed before optional ones.
	assert.equal(pi.options[0].required, true);
	assert.equal(pi.options[1].required, false);
	assert.equal(pi.options[1].type, 4);

	const piMessage = DISCORD_COMMANDS.find((command) => command.name === "pi-message");
	assert.equal(piMessage.type, 3);
	assert.equal(piMessage.options, undefined);
	// Discord rejects a description on context-menu commands.
	assert.equal(piMessage.description, "");

	for (const command of DISCORD_COMMANDS) {
		assert.match(command.name, /^[a-z0-9_-]{1,32}$/);
		if (command.type === 3) continue;
		assert.ok(command.description.length >= 1 && command.description.length <= 100);
	}
});

test("the Gateway identifies with the GUILDS and MESSAGE_CONTENT intents", () => {
	const { bridge } = createHarness();
	const sent = [];
	bridge.ws = {
		readyState: 1,
		send: (payload) => sent.push(JSON.parse(payload)),
		close: () => {},
	};
	bridge.handleGatewayPayload(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
	const identify = sent.find((payload) => payload.op === 2);
	assert.ok(identify);
	assert.equal(identify.d.intents, DISCORD_GATEWAY_INTENTS);
	assert.equal(identify.d.intents & (1 << 0), 1 << 0);
	assert.equal(identify.d.intents & (1 << 15), 1 << 15);
	bridge.stop();
});

test("replies are re-keyed to the host conversation and posted to the originating channel", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "Hello from pi" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	const reply = harness.apiCalls.find(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
	);
	assert.ok(reply);
	assert.equal(reply.payload.content, "Hello from pi");
	assert.deepEqual(reply.payload.message_reference, { message_id: "user-message-1" });
	assert.equal(harness.bridge.getStatus().messagesReplied, 1);
	assert.equal(harness.bridge.userConversations.get(AUTHOR_ID), "c1");
});

test("early assistant events are merged instead of posting to an undefined channel", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			queueMicrotask(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "early output" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	const replies = harness.apiCalls.filter(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
	);
	assert.equal(replies.length, 1);
	assert.equal(replies[0].payload.content, "early output");
	assert.ok(!harness.apiCalls.some((call) => call.path.includes("undefined")));
});

test("the same user keeps the same pseudo-client account across turns", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	await harness.bridge.onInboundMessage(message("first"));
	await harness.bridge.onInboundMessage(message("second"));
	assert.equal(harness.chatCalls.length, 2);
	assert.equal(harness.chatCalls[0].accountId, harness.chatCalls[1].accountId);
	assert.equal(harness.bridge.userConversations.get(AUTHOR_ID), "c1");
});

test("/new and /clear drop the binding and create a new generation", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	await harness.bridge.onInboundMessage(message("first"));
	const originalAccount = harness.chatCalls[0].accountId;
	await harness.bridge.onInboundMessage(message("/new"));
	assert.equal(harness.bridge.userConversations.has(AUTHOR_ID), false);
	assert.match(harness.bridge.userAccountId(AUTHOR_ID), /_g1$/);
	await harness.bridge.onInboundMessage(message("fresh"));
	assert.notEqual(harness.chatCalls[1].accountId, originalAccount);
	assert.match(harness.chatCalls[1].accountId, /_g1$/);
});

test("/cwd validates and persists a per-user workspace and starts a fresh generation", async () => {
	const root = await mkdtemp(join(tmpdir(), "discord-cwd-"));
	const project = join(root, "project");
	await mkdir(project);
	const harness = createHarness();
	try {
		await harness.bridge.onInboundMessage(message(`/cwd ${project}`));
		assert.equal(harness.bridge.userWorkspaces.get(AUTHOR_ID), project);
		assert.match(harness.bridge.userAccountId(AUTHOR_ID), /_g1$/);
		const reply = harness.apiCalls.find(
			(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
		);
		assert.match(reply.payload.content, /Workspace changed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/model changes the configured model after validating the host catalog", async () => {
	const harness = createHarness({ models: [{ id: "openai/gpt-5" }, { id: "anthropic/claude" }] });
	await harness.bridge.onInboundMessage(message("/model openai/gpt-5"));
	assert.equal(harness.config.model, "openai/gpt-5");
	await harness.bridge.onInboundMessage(message("/model missing/model"));
	assert.equal(harness.config.model, "openai/gpt-5");
});

test("native guild commands are registered with Discord's bulk-overwrite route", async () => {
	const harness = createHarness();
	await harness.bridge.handleReady({
		user: { id: BOT_ID, username: "Nero" },
		application: { id: "1564275983425609788" },
		guilds: [{ id: "949381557267857469" }],
	});
	const registration = harness.apiCalls.find(
		(call) => call.method === "PUT" && call.path.includes("/guilds/949381557267857469/commands"),
	);
	assert.ok(registration);
	assert.equal(
		registration.path,
		"/applications/1564275983425609788/guilds/949381557267857469/commands",
	);
	assert.deepEqual(registration.payload.map((command) => command.name), [
		"help",
		"status",
		"new",
		"clear",
		"cancel",
		"cwd",
		"model",
		"thinking",
		"system",
		"context",
		"read",
		"pi",
		"pi-message",
	]);
	assert.ok(harness.bridge.registeredGuilds.has("949381557267857469"));
	await harness.bridge.registerGuildCommands("949381557267857469");
	assert.equal(
		harness.apiCalls.filter(
			(call) => call.method === "PUT" && call.path.includes("/guilds/949381557267857469/commands"),
		).length,
		1,
	);
});

test("global commands are registered so user-installed apps can use them in DMs", async () => {
	const harness = createHarness();
	await harness.bridge.handleReady({
		user: { id: BOT_ID, username: "Nero" },
		application: { id: "1564275983425609788" },
		guilds: [{ id: "949381557267857469" }],
	});

	const global = harness.apiCalls.find(
		(call) => call.method === "PUT" && call.path === "/applications/1564275983425609788/commands",
	);
	assert.ok(global);
	assert.deepEqual(global.payload.map((command) => command.name), [
		"help",
		"status",
		"new",
		"clear",
		"cancel",
		"cwd",
		"model",
		"thinking",
		"system",
		"context",
		"read",
		"pi",
		"pi-message",
	]);
	for (const command of global.payload) {
		assert.deepEqual(command.integration_types, [0, 1]);
		assert.deepEqual(command.contexts, [0, 1, 2]);
	}
	assert.equal(harness.bridge.status.registeredGlobally, true);

	await harness.bridge.registerGlobalCommands();
	assert.equal(
		harness.apiCalls.filter(
			(call) => call.method === "PUT" && call.path === "/applications/1564275983425609788/commands",
		).length,
		1,
	);
});

test("command responses stay ephemeral outside the app's own DM", async () => {
	const harness = createHarness({ models: [{ id: "openai/gpt-5" }] });

	await harness.bridge.handleInteraction({
		id: "guild-interaction",
		token: "interaction-token",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		member: { user: { id: AUTHOR_ID } },
		guild_id: "949381557267857469",
		context: 0,
		data: { name: "help", options: [] },
	});
	const guildResponse = harness.apiCalls.at(-1);
	assert.equal(guildResponse.path, "/interactions/guild-interaction/interaction-token/callback");
	assert.equal(guildResponse.payload.data.flags, 64);

	await harness.bridge.handleInteraction({
		id: "dm-interaction",
		token: "interaction-token",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		user: { id: AUTHOR_ID },
		context: 1,
		data: { name: "help", options: [] },
	});
	const dmResponse = harness.apiCalls.at(-1);
	assert.equal(dmResponse.path, "/interactions/dm-interaction/interaction-token/callback");
	assert.equal(dmResponse.payload.data.flags, undefined);

	await harness.bridge.handleInteraction({
		id: "private-channel-interaction",
		token: "interaction-token",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		user: { id: AUTHOR_ID },
		context: 2,
		data: { name: "help", options: [] },
	});
	const privateResponse = harness.apiCalls.at(-1);
	assert.equal(privateResponse.path, "/interactions/private-channel-interaction/interaction-token/callback");
	assert.equal(privateResponse.payload.data.flags, 64);
});

test("native interactions answer ping, command, and autocomplete callbacks", async () => {
	const harness = createHarness({ models: [{ id: "openai/gpt-5" }] });
	await harness.bridge.handleInteraction({
		id: "interaction-1",
		token: "interaction-token",
		type: INTERACTION_TYPE.PING,
	});
	assert.deepEqual(harness.apiCalls.at(-1).payload, { type: INTERACTION_RESPONSE_TYPE.PONG });

	await harness.bridge.handleInteraction({
		id: "interaction-2",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE,
		member: { user: { id: AUTHOR_ID } },
		data: {
			name: "model",
			options: [{ name: "model", value: "gpt", focused: true }],
		},
	});
	const autocomplete = harness.apiCalls.at(-1);
	assert.equal(autocomplete.path, "/interactions/interaction-2/interaction-token/callback");
	assert.equal(autocomplete.payload.type, INTERACTION_RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
	assert.deepEqual(autocomplete.payload.data.choices, [{ name: "openai/gpt-5", value: "openai/gpt-5" }]);

	await harness.bridge.handleInteraction({
		id: "interaction-3",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "status", options: [] },
	});
	const deferred = harness.apiCalls.find(
		(call) => call.path === "/interactions/interaction-3/interaction-token/callback",
	);
	assert.equal(deferred.payload.type, INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
	const edited = harness.apiCalls.find((call) => call.method === "PATCH");
	assert.equal(edited.path, "/webhooks/1564275983425609788/interaction-token/messages/@original");
	assert.match(edited.payload.content, /Discord bot status/);
});

test("unauthorized users cannot invoke native commands or send chat prompts", async () => {
	const config = baseConfig({ allowedUsers: ["another-user"] });
	const harness = createHarness({ config });
	await harness.bridge.handleInteraction({
		id: "interaction-1",
		token: "token",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "status", options: [] },
	});
	assert.equal(harness.apiCalls.at(-1).payload.type, INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
	assert.match(harness.apiCalls.at(-1).payload.data.content, /Access denied/);
	await harness.bridge.onInboundMessage(message("hello"));
	assert.equal(harness.chatCalls.length, 0);
});

test("directory autocomplete filters directories under the current workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "discord-autocomplete-"));
	await mkdir(join(root, "alpha"));
	await mkdir(join(root, "beta"));
	await mkdir(join(root, "nested"));
	await mkdir(join(root, "nested", "beta"));
	try {
		const choices = await buildDirectoryChoices(root, "al");
		assert.deepEqual(choices, [{ name: "alpha", value: join(root, "alpha") }]);
		const nested = await buildDirectoryChoices(root, "nested/");
		assert.deepEqual(nested, [{ name: "nested/beta", value: join(root, "nested", "beta") }]);
		assert.deepEqual(await buildDirectoryChoices(root, "/etc"), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/read loads the channel into the chat context without triggering a turn", async () => {
	const harness = createHarness();
	harness.apiCalls.length = 0;
	const messages = [
		{ id: "m3", content: "third", author: { id: "user-b", username: "bee" }, timestamp: "2026-01-03T00:00:00.000Z" },
		{ id: "m2", content: "second", author: { id: "user-a", username: "ay" }, timestamp: "2026-01-02T00:00:00.000Z" },
		{ id: "m1", content: "first", author: { id: AUTHOR_ID, username: "jery" }, timestamp: "2026-01-01T00:00:00.000Z" },
	];
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET" && path.startsWith(`/channels/${CHANNEL_ID}/messages`)) return messages;
		if (method === "GET") return { id: CHANNEL_ID, name: "general" };
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-read",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "read", options: [{ name: "count", value: 3 }] },
	});

	const fetchCall = harness.apiCalls.find((call) => call.method === "GET" && call.path.includes("/messages"));
	assert.equal(fetchCall.path, `/channels/${CHANNEL_ID}/messages?limit=3`);

	// The confirmation is ephemeral and short: no transcript dump.
	const response = harness.apiCalls.find((call) => call.path.includes("/callback"));
	assert.equal(response.payload.type, INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
	assert.equal(response.payload.data.flags, 64);
	assert.match(response.payload.data.content, /3 messages loaded into the chat context/);
	assert.ok(!response.payload.data.content.includes("third"));

	// No agent turn was triggered.
	assert.equal(harness.chatCalls.length, 0);

	// The messages are stored for the next prompt.
	const batches = harness.bridge.loadedBatches(AUTHOR_ID);
	assert.equal(batches.length, 1);
	assert.equal(batches[0].messages.length, 3);
	assert.equal(batches[0].channelName, "#general");
});

test("the context loaded with /read is carried by the next prompt from any channel", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET" && path.startsWith(`/channels/${CHANNEL_ID}/messages`)) {
			return [{ id: "m1", content: "the loaded line", author: { id: "user-a", username: "ay" } }];
		}
		if (method === "GET") return { id: CHANNEL_ID, name: "general" };
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-read",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "read", options: [{ name: "count", value: 1 }] },
	});

	// A later prompt, from another channel, carries the loaded context.
	await harness.bridge.onInboundMessage({
		id: "user-message-2",
		channel_id: "999999999999999999",
		author: { id: AUTHOR_ID, bot: false },
		content: "what did they say?",
		mentions: [],
	});

	assert.equal(harness.chatCalls.length, 1);
	assert.match(harness.chatCalls[0].text, /<discord_context>/);
	assert.match(harness.chatCalls[0].text, /the loaded line/);
	assert.match(harness.chatCalls[0].text, /what did they say\?/);
});

test("/context shows and clears the loaded context", async () => {
	const harness = createHarness();
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET" && path.startsWith(`/channels/${CHANNEL_ID}/messages`)) {
			return [{ id: "m1", content: "the loaded line", author: { id: "user-a", username: "ay" } }];
		}
		if (method === "GET") return { id: CHANNEL_ID, name: "general" };
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-read",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "read", options: [] },
	});
	assert.equal(harness.bridge.loadedBatches(AUTHOR_ID).length, 1);

	harness.apiCalls.length = 0;
	await harness.bridge.handleInteraction({
		id: "interaction-context-show",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "context", options: [{ name: "action", value: "show" }] },
	});
	let response = harness.apiCalls.find((call) => call.path.includes("/callback"));
	assert.match(response.payload.data.content, /Loaded chat context/);
	assert.match(response.payload.data.content, /#general/);

	harness.apiCalls.length = 0;
	await harness.bridge.handleInteraction({
		id: "interaction-context-clear",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "context", options: [{ name: "action", value: "clear" }] },
	});
	response = harness.apiCalls.find((call) => call.path.includes("/callback"));
	assert.match(response.payload.data.content, /Chat context cleared/);
	assert.equal(harness.bridge.loadedBatches(AUTHOR_ID).length, 0);
});

test("the Discord core prompt is stated once per conversation, not on every turn", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		return { id: "message-1" };
	};

	await harness.bridge.onInboundMessage(message("first turn"));
	assert.match(harness.chatCalls[0].text, /<discord_core_prompt>/);

	await harness.bridge.onInboundMessage(message("second turn"));
	assert.ok(!harness.chatCalls[1].text.includes("<discord_core_prompt>"));
	assert.match(harness.chatCalls[1].text, /second turn/);

	// A fresh conversation states it again.
	harness.bridge.resetUserConversation(AUTHOR_ID);
	await harness.bridge.onInboundMessage(message("third turn"));
	assert.match(harness.chatCalls[2].text, /<discord_core_prompt>/);
});

test("the plain-text /read and /context commands load and drop the context", async () => {
	const harness = createHarness();
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET" && path.startsWith(`/channels/${CHANNEL_ID}/messages`)) {
			return [{ id: "m1", content: "the loaded line", author: { id: "user-a", username: "ay" } }];
		}
		if (method === "GET") return { id: CHANNEL_ID, name: "general" };
		return { id: "message-1" };
	};

	await harness.bridge.onInboundMessage(message("/read 1"));
	const posted = harness.apiCalls.filter((call) => call.method === "POST" && call.path.includes("/messages"));
	assert.equal(posted.length, 1);
	assert.match(posted[0].payload.content, /1 message loaded into the chat context/);
	assert.equal(harness.chatCalls.length, 0);
	assert.equal(harness.bridge.loadedBatches(AUTHOR_ID).length, 1);

	harness.apiCalls.length = 0;
	await harness.bridge.onInboundMessage(message("/context"));
	const shown = harness.apiCalls.find((call) => call.method === "POST" && call.path.includes("/messages"));
	assert.match(shown.payload.content, /Loaded chat context/);
	assert.match(shown.payload.content, /#general/);

	harness.apiCalls.length = 0;
	await harness.bridge.onInboundMessage(message("/context clear"));
	const cleared = harness.apiCalls.find((call) => call.method === "POST" && call.path.includes("/messages"));
	assert.match(cleared.payload.content, /Chat context cleared/);
	assert.equal(harness.bridge.loadedBatches(AUTHOR_ID).length, 0);
});

test("editing the core prompt mid-conversation re-states it in the running conversation", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		return { id: "message-1" };
	};

	await harness.bridge.onInboundMessage(message("first turn"));
	assert.match(harness.chatCalls[0].text, /<discord_core_prompt>/);

	// Edit the core prompt while the conversation is running.
	const result = await harness.bridge.executeCommand("system", { replace: "Speak like a pirate." }, {
		authorId: AUTHOR_ID,
		config: harness.config,
	});
	assert.match(result, /replaced/);
	assert.match(result, /current conversation/);

	await harness.bridge.onInboundMessage(message("second turn"));
	// The new prompt is stated once and supersedes the old one.
	assert.match(harness.chatCalls[1].text, /<discord_core_prompt_update>/);
	assert.match(harness.chatCalls[1].text, /Speak like a pirate\./);
	assert.match(harness.chatCalls[1].text, /replaces the earlier core prompt/);
	assert.ok(!harness.chatCalls[1].text.includes("<discord_core_prompt>"));

	// And it is not repeated again on the following turn.
	await harness.bridge.onInboundMessage(message("third turn"));
	assert.ok(!harness.chatCalls[2].text.includes("<discord_core_prompt_update>"));
	assert.ok(!harness.chatCalls[2].text.includes("<discord_core_prompt>"));
});

test("/read explains that a user-installed app cannot read third-party DM history", async () => {
	const harness = createHarness();
	harness.apiCalls.length = 0;
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET") {
			const error = new Error("Missing Access");
			error.status = 403;
			error.code = 50001;
			throw error;
		}
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-read-denied",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		context: 2,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "read", options: [] },
	});

	const response = harness.apiCalls.find((call) => call.path.includes("/callback"));
	assert.match(response.payload.data.content, /Could not read the channel history/);
	assert.match(response.payload.data.content, /Missing Access/);
	assert.match(response.payload.data.content, /`\/pi <message>` still works/);
	// A third-party DM has no bot presence, so the answer stays ephemeral.
	assert.equal(response.payload.data.flags, 64);
});

test("/pi runs the agent through the same pipeline as an @mention and answers via the interaction", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "the answer" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.apiCalls.length = 0;
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET" && path.startsWith(`/channels/${CHANNEL_ID}/messages`)) {
			return [{ id: "m1", content: "earlier context", author: { id: "user-a", username: "ay" } }];
		}
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-pi",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "pi", options: [{ name: "message", value: "what is up" }] },
	});

	// The prompt travels through the same host request as an @mention.
	assert.equal(harness.chatCalls.length, 1);
	assert.match(harness.chatCalls[0].text, /what is up/);
	// The default context window is five messages.
	const fetchCall = harness.apiCalls.find((call) => call.method === "GET");
	assert.equal(fetchCall.path, `/channels/${CHANNEL_ID}/messages?limit=5`);
	assert.match(harness.chatCalls[0].text, /earlier context/);

	// The answer is published through the interaction response, not the channel.
	const edited = harness.apiCalls.find((call) => call.method === "PATCH");
	assert.equal(edited.path, "/webhooks/1564275983425609788/interaction-token/messages/@original");
	assert.equal(edited.payload.content, "the answer");
	assert.ok(!harness.apiCalls.some((call) => call.path === `/channels/${CHANNEL_ID}/messages` && call.method === "POST"));
});

test("/pi honours the optional context count and keeps its reply ephemeral in a third-party DM", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "private answer" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.apiCalls.length = 0;
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET") return [];
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-pi-dm",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		context: 2,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "pi", options: [{ name: "message", value: "hello" }, { name: "context", value: 12 }] },
	});

	const fetchCall = harness.apiCalls.find((call) => call.method === "GET");
	assert.equal(fetchCall.path, `/channels/${CHANNEL_ID}/messages?limit=12`);
	const deferred = harness.apiCalls.find((call) => call.path.includes("/callback"));
	assert.equal(deferred.payload.type, INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
	assert.equal(deferred.payload.data.flags, 64);
	const edited = harness.apiCalls.find((call) => call.method === "PATCH");
	assert.equal(edited.payload.flags, 64);
	assert.equal(edited.payload.content, "private answer");
});

test("/pi keeps a public reply in a guild where the bot is a member", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "public answer" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.apiCalls.length = 0;
	harness.bridge.knownGuilds.add("guild-1");
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET") return [];
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-pi-guild",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		guild_id: "guild-1",
		context: 0,
		member: { user: { id: AUTHOR_ID } },
		data: { name: "pi", options: [{ name: "message", value: "hello" }] },
	});

	const deferred = harness.apiCalls.find((call) => call.path.includes("/callback"));
	assert.equal(deferred.payload.data.flags, undefined);
	const edited = harness.apiCalls.find((call) => call.method === "PATCH");
	assert.equal(edited.payload.flags, undefined);
});

test("the pi-message context command uses the invoked message as the prompt", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "ack" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.apiCalls.length = 0;
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET") return [];
		return { id: "message-1" };
	};

	await harness.bridge.handleInteraction({
		id: "interaction-pi-message",
		token: "interaction-token",
		application_id: "1564275983425609788",
		type: INTERACTION_TYPE.APPLICATION_COMMAND,
		channel_id: CHANNEL_ID,
		member: { user: { id: AUTHOR_ID } },
		data: {
			name: "pi-message",
			target_id: "target-1",
			resolved: { messages: { "target-1": { id: "target-1", content: "the selected message" } } },
		},
	});

	assert.equal(harness.chatCalls.length, 1);
	assert.match(harness.chatCalls[0].text, /the selected message/);
});

test("plain-text /pi still reaches the agent instead of being swallowed as a command", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: "legacy answer" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.apiCalls.length = 0;
	harness.bridge.api = async (token, method, path, payload) => {
		harness.apiCalls.push({ token, method, path, payload });
		if (method === "GET") return [];
		return { id: "message-1" };
	};

	await harness.bridge.onInboundMessage(message("/pi please summarise this"));
	assert.equal(harness.chatCalls.length, 1);
	assert.match(harness.chatCalls[0].text, /please summarise this/);
});

test("history helpers clamp counts and render channel messages", () => {
	assert.equal(normalizeReadCount(""), DISCORD_READ_DEFAULT_COUNT);
	assert.equal(normalizeReadCount(undefined, 5), 5);
	assert.equal(normalizeReadCount("7"), 7);
	assert.equal(normalizeReadCount(0), 0);
	assert.equal(normalizeReadCount(-3), 0);
	assert.equal(normalizeReadCount(999), DISCORD_READ_MAX_COUNT);
	assert.equal(normalizeReadCount("not a number", 3), 3);

	const messages = [
		{ content: "newest", author: { id: "u2", username: "bee" } },
		{ content: "oldest", author: { id: BOT_ID, bot: true } },
	];
	const context = formatChannelContext(messages, { botId: BOT_ID });
	assert.match(context, /Recent messages in this Discord channel/);
	// Oldest first so the agent reads the conversation in order.
	assert.ok(context.indexOf("oldest") < context.indexOf("newest"));
	assert.match(context, /the bot: oldest/);

	const transcript = formatChannelTranscript(messages, { botId: BOT_ID });
	assert.equal(transcript.length, 2);
	assert.match(transcript[0], /the bot.*: oldest/);
	assert.match(transcript[1], /@bee.*: newest/);
});

test("the discord agent tool accepts pi-web-ui's execute(toolCallId, params) convention", async () => {
	let registeredTool = null;
	const host = {
		cwd: "/home/jery",
		models: { list: () => [] },
		storage: {
			get: async (key) => (key === "config"
				? { botToken: "test-token", botEnabled: false, allowedUsers: [AUTHOR_ID], defaultChannelId: CHANNEL_ID }
				: {}),
			set: async () => {},
		},
		secrets: {
			getAll: async () => ({}),
			get: async () => "",
			set: async () => {},
			delete: async () => {},
		},
		registerAgentTool: (tool) => {
			registeredTool = tool;
			return () => {};
		},
		onClientMessage: () => () => {},
		onRunEvent: () => () => {},
		chat: async () => ({ conversationId: "c1" }),
		log: () => {},
	};

	const cleanup = await activate(host);
	assert.ok(registeredTool);

	// pi-web-ui calls agent tools as execute(toolCallId, params, signal, onUpdate).
	const status = JSON.parse(await registeredTool.execute("call-1", { action: "status" }));
	assert.equal(typeof status.state, "string");

	// The legacy single-argument form must keep working too.
	const legacy = JSON.parse(await registeredTool.execute({ action: "status" }));
	assert.equal(legacy.state, status.state);

	await assert.rejects(
		() => registeredTool.execute("call-2", { action: "nope" }),
		/Unknown Discord tool action: nope/,
	);

	await cleanup();
});

test("activation correlates UI replies and unregisters the client handler on cleanup", async () => {
	let clientMessageHandler = null;
	let clientHandlerCount = 0;
	let clientHandlerCleanupCount = 0;
	let toolCleanupCount = 0;
	const replies = [];
	const host = {
		cwd: "/home/jery",
		models: { list: () => [] },
		storage: {
			get: async (key) => key === "config"
				? { botToken: "test-token", botEnabled: false, allowedUsers: [AUTHOR_ID] }
				: {},
			set: async () => {},
		},
		secrets: {
			getAll: async () => ({}),
			get: async () => "",
			set: async () => {},
			delete: async () => {},
		},
		registerAgentTool: () => () => { toolCleanupCount += 1; },
		onClientMessage: (handler) => {
			clientMessageHandler = handler;
			clientHandlerCount += 1;
			return () => {
				clientHandlerCleanupCount += 1;
				clientMessageHandler = null;
			};
		},
		onRunEvent: () => () => {},
		chat: async () => ({ conversationId: "c1" }),
		log: () => {},
	};

	const cleanup = await activate(host);
	assert.equal(clientHandlerCount, 1);
	assert.ok(clientMessageHandler);
	await clientMessageHandler({ type: "get_state", requestId: "request-1" }, (reply) => replies.push(reply));
	assert.equal(replies.at(-1).type, "state");
	assert.equal(replies.at(-1).requestId, "request-1");

	await cleanup();
	assert.equal(clientHandlerCleanupCount, 1);
	assert.equal(toolCleanupCount, 1);
	assert.equal(clientMessageHandler, null);
});

test("all user-facing plugin files are English-first", async () => {
	for (const file of ["index.mjs", "client/entry.mjs", "client/host-bridge.mjs", "manifest.json", "README.md"]) {
		const content = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
		assert.equal(/[\u3400-\u9fff]/u.test(content), false, `${file} contains CJK text`);
	}
});
