import assert from "node:assert/strict";
import test from "node:test";

import {
	DISCORD_COMMANDS,
	DISCORD_EPHEMERAL_FLAG,
	INTERACTION_TYPE,
	DiscordBotBridge,
	parseModelArguments,
	sessionKey,
	sessionScope,
} from "../index.mjs";

const AUTHOR_ID = "401364668204099585";
const BOT_ID = "999999999999999999";
const CHANNEL_ID = "1031955437005848616";
const GUILD_ID = "guild-1";
const DM_SCOPE = "dm";
const GUILD_SCOPE = `guild:${GUILD_ID}:${CHANNEL_ID}`;

function baseConfig(overrides = {}) {
	return {
		botToken: "test-token",
		botEnabled: true,
		allowedUsers: [AUTHOR_ID],
		defaultChannelId: CHANNEL_ID,
		workspace: "/home/jery",
		model: "",
		thinkingLevel: "",
		useWorkspaceSession: false,
		...overrides,
	};
}

/**
 * A harness that keeps the configuration in memory, so a test can restart the
 * plugin with the very same storage.
 */
function createHarness({ config = baseConfig(), hostChat, models = [] } = {}) {
	const apiCalls = [];
	const chatCalls = [];
	let bridge;
	const host = {
		cwd: "/home/jery",
		models: { list: () => models },
		onRunEvent: () => () => {},
		chat: async (request) => {
			chatCalls.push(request);
			const dispatched = hostChat
				? await hostChat(request, bridge)
				: { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
			const conversationId = dispatched?.conversationId || "c1";
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId,
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId });
			});
			return dispatched;
		},
		conversations: { list: async () => [], get: async () => null },
		getActiveConversation: async () => null,
		abortRun: async () => ({ ok: true }),
	};
	const api = async (token, method, path, payload) => {
		apiCalls.push({ token, method, path, payload });
		if (method === "PUT") return DISCORD_COMMANDS;
		return { id: "message-1", content: payload?.content || "" };
	};
	bridge = new DiscordBotBridge({
		host,
		getConfig: () => config,
		updateConfig: async (patch) => Object.assign(config, patch),
		api,
		log: () => {},
	});
	bridge.botUser = { id: BOT_ID, username: "Nero" };
	return { bridge, apiCalls, chatCalls, config, host, api };
}

function dmMessage(text, overrides = {}) {
	return {
		id: "dm-message-1",
		channel_id: CHANNEL_ID,
		author: { id: AUTHOR_ID, bot: false },
		content: text,
		mentions: [],
		...overrides,
	};
}

function guildMessage(text, overrides = {}) {
	return {
		id: "guild-message-1",
		channel_id: CHANNEL_ID,
		guild_id: GUILD_ID,
		author: { id: AUTHOR_ID, bot: false },
		content: text,
		mentions: [{ id: BOT_ID }],
		...overrides,
	};
}

test("a DM and a guild channel are separate scopes", () => {
	assert.equal(sessionScope({}), "dm");
	assert.equal(sessionScope({ guildId: GUILD_ID, channelId: CHANNEL_ID }), GUILD_SCOPE);
	assert.notEqual(sessionKey(DM_SCOPE, AUTHOR_ID), sessionKey(GUILD_SCOPE, AUTHOR_ID));
	assert.equal(sessionKey(DM_SCOPE, AUTHOR_ID), `dm|${AUTHOR_ID}`);
});

test("the session id of a scope is written to the configuration and reused", async () => {
	const harness = createHarness({
		hostChat: async (request) => ({
			conversationId: request.conversationId || "conversation-1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	assert.equal(harness.config.userSessions[`dm|${AUTHOR_ID}`].conversationId, "conversation-1");
	assert.equal(harness.bridge.userSessions.get(`dm|${AUTHOR_ID}`).conversationId, "conversation-1");
	await harness.bridge.onInboundMessage(dmMessage("again"));
	assert.equal(harness.chatCalls[1].conversationId, "conversation-1");
});

test("a stored session survives a restart of the plugin", async () => {
	const config = baseConfig();
	const first = createHarness({
		config,
		hostChat: async (request) => ({
			conversationId: request.conversationId || "conversation-1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await first.bridge.onInboundMessage(dmMessage("hello"));
	assert.equal(config.userSessions[`dm|${AUTHOR_ID}`].conversationId, "conversation-1");
	const second = createHarness({
		config,
		hostChat: async (request) => ({
			conversationId: request.conversationId || "conversation-1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	assert.equal(second.bridge.userSessions.get(`dm|${AUTHOR_ID}`).conversationId, "conversation-1");
	await second.bridge.onInboundMessage(dmMessage("after restart"));
	assert.equal(second.chatCalls[0].conversationId, "conversation-1");
});

test("/new drops the stored session id and the next turn stores a new one", async () => {
	const harness = createHarness({
		hostChat: async (request) => ({
			conversationId: request.conversationId || `conversation-${request.accountId}`,
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	assert.ok(harness.config.userSessions[`dm|${AUTHOR_ID}`]);
	await harness.bridge.onInboundMessage(dmMessage("/new"));
	assert.equal(harness.bridge.userSessions.has(`dm|${AUTHOR_ID}`), false);
	assert.equal(harness.config.userSessions[`dm|${AUTHOR_ID}`], undefined);
	await harness.bridge.onInboundMessage(dmMessage("fresh"));
	assert.ok(harness.config.userSessions[`dm|${AUTHOR_ID}`]?.conversationId);
	assert.match(harness.chatCalls[1].accountId, /_g1$/);
});

test("a DM session is never reused in a guild channel", async () => {
	const harness = createHarness({
		hostChat: async (request) => ({
			conversationId: request.conversationId || "conversation-1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	assert.equal(harness.config.userSessions[`dm|${AUTHOR_ID}`].conversationId, "conversation-1");
	assert.equal(harness.config.userSessions[`${GUILD_SCOPE}|${AUTHOR_ID}`], undefined);
	await harness.bridge.onInboundMessage(guildMessage("hello"));
	const guildRequest = harness.chatCalls.at(-1);
	assert.equal(guildRequest.conversationId, undefined);
	assert.notEqual(guildRequest.accountId, harness.chatCalls[0].accountId);
	assert.equal(harness.config.userSessions[`${GUILD_SCOPE}|${AUTHOR_ID}`].conversationId, "conversation-1");
	assert.equal(harness.config.userSessions[`dm|${AUTHOR_ID}`].conversationId, "conversation-1");
});

test("/status lists the user details and the active session id", async () => {
	const harness = createHarness({
		hostChat: async (request) => ({
			conversationId: request.conversationId || "conversation-1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	await harness.bridge.onInboundMessage(dmMessage("/status"));
	const reply = harness.apiCalls.filter((call) => call.method === "POST").at(-1);
	assert.match(reply.payload.content, /### This user/);
	assert.match(reply.payload.content, new RegExp(`Discord user: ${AUTHOR_ID}`));
	assert.match(reply.payload.content, /Scope: `dm`/);
	assert.match(reply.payload.content, /Pi session id: `conversation-1`/);
	assert.match(reply.payload.content, /Session account: `dc_/);
});

test("a DM answers with a plain message and a guild channel keeps the reply", async () => {
	const harness = createHarness({
		hostChat: async (request) => ({
			conversationId: "c1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	const dmReply = harness.apiCalls
		.filter((call) => call.method === "POST" && call.path.endsWith("/messages"))
		.at(-1);
	assert.equal(dmReply.payload.content, "ok");
	assert.equal(dmReply.payload.message_reference, undefined);
	await harness.bridge.onInboundMessage(guildMessage("hello"));
	const guildReply = harness.apiCalls
		.filter((call) => call.method === "POST" && call.path.endsWith("/messages"))
		.at(-1);
	assert.equal(guildReply.payload.content, "ok");
	assert.deepEqual(guildReply.payload.message_reference, { message_id: "guild-message-1" });
});

test("a thread started from a bot reply answers automatically without touching the config", async () => {
	const config = baseConfig({ autoReplyEnabled: true });
	const harness = createHarness({
		config,
		hostChat: async (request) => ({
			conversationId: "c1",
			clientId: `plugin:discord:${request.accountId}`,
		}),
	});
	await harness.bridge.onInboundMessage(guildMessage("hello"));
	const botMessage = harness.apiCalls
		.filter((call) => call.method === "POST" && call.path.endsWith("/messages"))
		.at(-1);
	assert.ok(botMessage);
	await harness.bridge.onThreadCreate({
		id: "thread-9",
		parent_id: CHANNEL_ID,
		message: { id: "message-1", author: { id: BOT_ID } },
	});
	assert.equal(harness.bridge.autoReplyThreadIds.has("thread-9"), true);
	assert.equal(config.autoReplyChannels, undefined);
	const chatCallsBefore = harness.chatCalls.length;
	await harness.bridge.onInboundMessage(
		guildMessage("thread reply", {
			id: "thread-message-1",
			channel_id: "thread-9",
			mentions: [],
		}),
	);
	assert.equal(harness.chatCalls.length, chatCallsBefore + 1);
});

test("/model parses a model, a thinking level, or both", () => {
	assert.deepEqual(parseModelArguments("openai/gpt-5"), {
		model: "openai/gpt-5",
		thinking: "",
		thinkingReset: false,
		invalid: "",
	});
	assert.deepEqual(parseModelArguments("high"), {
		model: "",
		thinking: "high",
		thinkingReset: false,
		invalid: "",
	});
	assert.deepEqual(parseModelArguments("openai/gpt-5 max"), {
		model: "openai/gpt-5",
		thinking: "max",
		thinkingReset: false,
		invalid: "",
	});
	assert.deepEqual(parseModelArguments("default"), {
		model: "",
		thinking: "",
		thinkingReset: true,
		invalid: "",
	});
	assert.equal(parseModelArguments("turbo").invalid, "turbo");
});

test("every slash command answers ephemerally", async () => {
	const harness = createHarness();
	for (const name of ["help", "status", "new", "cancel"]) {
		await harness.bridge.handleInteraction({
			id: `interaction-${name}`,
			token: "interaction-token",
			type: INTERACTION_TYPE.APPLICATION_COMMAND,
			member: { user: { id: AUTHOR_ID } },
			guild_id: GUILD_ID,
			context: 0,
			data: { name, options: [] },
		});
		const response = harness.apiCalls.at(-1);
		assert.equal(response.path, `/interactions/interaction-${name}/interaction-token/callback`);
		assert.equal(response.payload.data.flags, DISCORD_EPHEMERAL_FLAG);
	}
});
