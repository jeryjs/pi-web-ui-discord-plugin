import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import activate, {
	DISCORD_COMMANDS,
	DISCORD_GATEWAY_INTENTS,
	INTERACTION_RESPONSE_TYPE,
	INTERACTION_TYPE,
	DiscordBotBridge,
	buildDirectoryChoices,
	extractDiscordText,
	isAllowedUser,
	mergeSavedSecrets,
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
		["help", "status", "new", "clear", "cancel", "cwd", "model", "thinking", "system"],
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
	for (const command of DISCORD_COMMANDS) {
		assert.match(command.name, /^[a-z0-9_-]{1,32}$/);
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
