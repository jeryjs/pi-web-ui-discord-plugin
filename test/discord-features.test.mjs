import assert from "node:assert/strict";
import test from "node:test";

import {
	DISCORD_COMMANDS,
	DiscordBotBridge,
	buildCorePrompt,
	buildReplyContext,
	buildRequestText,
	extractLastAssistantText,
	isMessageAddressedToBot,
	normalizeThinkingLevel,
	parseSystemArguments,
	parseSystemCommandArgument,
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

function createHarness({ config = baseConfig(), hostChat, conversations = [], active = null } = {}) {
	const apiCalls = [];
	const chatCalls = [];
	let bridge;
	const host = {
		cwd: "/home/jery",
		models: { list: () => [] },
		onRunEvent: () => () => {},
		chat: async (request) => {
			chatCalls.push(request);
			if (hostChat) return hostChat(request, bridge);
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
		conversations: {
			list: async () => conversations,
			get: async () => null,
		},
		getActiveConversation: async () => active,
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
	return { bridge, apiCalls, chatCalls, config, host };
}

function message(text, overrides = {}) {
	return {
		id: "user-message-1",
		channel_id: CHANNEL_ID,
		guild_id: "guild-1",
		author: { id: AUTHOR_ID, bot: false },
		content: text,
		mentions: [{ id: BOT_ID }],
		...overrides,
	};
}

test("thinking levels are normalized and exposed as native command choices", () => {
	assert.equal(normalizeThinkingLevel("HIGH"), "high");
	assert.equal(normalizeThinkingLevel("medium"), "medium");
	assert.equal(normalizeThinkingLevel("default"), "");
	assert.equal(normalizeThinkingLevel("turbo"), "");
	const thinking = DISCORD_COMMANDS.find((command) => command.name === "thinking");
	assert.ok(thinking);
	assert.deepEqual(
		thinking.options[0].choices.map((choice) => choice.value),
		["off", "low", "medium", "high", "max"],
	);
});

test("/thinking changes the persisted thinking level and rejects unknown values", async () => {
	const harness = createHarness();
	await harness.bridge.onInboundMessage(message("/thinking high"));
	assert.equal(harness.config.thinkingLevel, "high");
	await harness.bridge.onInboundMessage(message("/thinking turbo"));
	assert.equal(harness.config.thinkingLevel, "high");
	await harness.bridge.onInboundMessage(message("/thinking default"));
	assert.equal(harness.config.thinkingLevel, "");
	const reply = harness.apiCalls.filter((call) => call.method === "POST").at(-1);
	assert.match(reply.payload.content, /Thinking level/);
});

test("/system replaces and appends the core prompt and rejects both options at once", async () => {
	const harness = createHarness();
	await harness.bridge.onInboundMessage(message("/system replace Only answer with code."));
	assert.equal(harness.config.systemPrompt, "Only answer with code.");
	assert.equal(harness.config.systemPromptMode, "replace");

	await harness.bridge.onInboundMessage(message("/system append Always include the file path."));
	assert.equal(
		harness.config.systemPrompt,
		"Only answer with code.\n\nAlways include the file path.",
	);
	assert.equal(harness.config.systemPromptMode, "append");

	await harness.bridge.onInboundMessage(message("/system"));
	const reply = harness.apiCalls.filter((call) => call.method === "POST").at(-1);
	assert.match(reply.payload.content, /Discord core system prompt/);
	assert.match(reply.payload.content, /Always include the file path\./);

	const both = parseSystemArguments({ replace: "a", append: "b" });
	assert.match(both.error, /mutually exclusive/);
	assert.deepEqual(parseSystemCommandArgument("append hello"), { replace: "", append: "hello" });
	assert.deepEqual(parseSystemCommandArgument("replace hello"), { replace: "hello", append: "" });
	assert.equal(parseSystemCommandArgument("nonsense").invalid, "nonsense");
});

test("the core prompt and reply context are part of the routed request text", async () => {
	const config = baseConfig({ systemPrompt: "Be terse.", systemPromptMode: "replace" });
	const harness = createHarness({ config });
	await harness.bridge.onInboundMessage(message("do it"));
	const request = harness.chatCalls[0];
	assert.match(request.text, /<discord_core_prompt>\nBe terse\.\n<\/discord_core_prompt>/);
	assert.match(request.text, /<discord_user_message>\ndo it\n<\/discord_user_message>/);
	assert.equal(buildCorePrompt(config), "Be terse.");
	assert.equal(buildCorePrompt({}), buildCorePrompt({ systemPrompt: "" }));
	assert.match(buildRequestText({ text: "hi", config }).split("\n")[0], /discord_core_prompt/);
});

test("messages in configured channels reach the bot without an @mention", async () => {
	const harness = createHarness({
		config: baseConfig({ autoReplyEnabled: true, autoReplyChannels: ["channel-2"] }),
	});
	await harness.bridge.onInboundMessage(message("plain message", { mentions: [] }));
	assert.equal(harness.chatCalls.length, 1);

	const other = createHarness();
	await other.bridge.onInboundMessage(message("plain message", { mentions: [] }));
	assert.equal(other.chatCalls.length, 0);

	const mentioned = createHarness();
	await mentioned.bridge.onInboundMessage(
		message(`<@!${BOT_ID}> ping`, { mentions: [{ id: BOT_ID }] }),
	);
	assert.equal(mentioned.chatCalls.length, 1);
	assert.equal(
		isMessageAddressedToBot(message("x", { mentions: [] }), { botId: BOT_ID, config: baseConfig() }),
		false,
	);
	assert.equal(
		isMessageAddressedToBot(message("x", { mentions: [] }), {
			botId: BOT_ID,
			config: baseConfig({ autoReplyEnabled: true }),
		}),
		true,
	);
});

test("replying to a bot message reaches the bot and carries the referenced context", async () => {
	const harness = createHarness();
	const referenced = {
		id: "bot-message-1",
		author: { id: BOT_ID, bot: true, username: "Nero" },
		content: "the earlier answer",
	};
	await harness.bridge.onInboundMessage(
		message("what about this?", {
			message_reference: { message_id: referenced.id, channel_id: CHANNEL_ID },
			referenced_message: referenced,
		}),
	);
	assert.equal(harness.chatCalls.length, 1);
	const request = harness.chatCalls[0];
	assert.match(request.text, /<discord_reply_context>/);
	assert.match(request.text, /the earlier answer/);
	assert.match(request.text, /Replying to the bot/);
});

test("a missing referenced message is fetched from the Discord API", async () => {
	const harness = createHarness();
	await harness.bridge.onInboundMessage(
		message("follow up", {
			message_reference: { message_id: "message-42", channel_id: CHANNEL_ID },
		}),
	);
	const lookup = harness.apiCalls.find((call) => call.method === "GET");
	assert.equal(lookup.path, `/channels/${CHANNEL_ID}/messages/message-42`);
	const context = buildReplyContext({ author: { id: "42", username: "alice" }, content: "hello" });
	assert.match(context, /Replying to @alice \(42\):\nhello/);
});

test("Discord runs reuse the pi session that is open in pi-web-ui", async () => {
	const harness = createHarness({
		active: { conversationId: "c7", cwd: "/home/jery" },
		hostChat: async (request, bridge) => {
			const conversationId = request.conversationId || "c1";
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId,
					message: { role: "assistant", content: "ok" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId });
			});
			return { conversationId, clientId: "browser-client" };
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	assert.equal(harness.chatCalls[0].conversationId, "c7");
	const reply = harness.apiCalls.filter((call) => call.method === "POST").at(-1);
	assert.ok(reply);
});

test("a run without message events recovers the assistant text from the transcript", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	harness.host.conversations.get = async () => ({
		conversationId: "c1",
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "the real answer" }], timestamp: 2 },
		],
	});
	await harness.bridge.onInboundMessage(message("hello"));
	const reply = harness.apiCalls.filter(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
	);
	assert.equal(reply.at(-1).payload.content, "the real answer");
	assert.equal(
		extractLastAssistantText({ messages: [{ role: "assistant", content: "text" }] }),
		"text",
	);
});

test("an aborted run reports the assistant error instead of an empty completion", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					message: { role: "assistant", content: [], errorMessage: "model refused the request" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1" });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	const reply = harness.apiCalls.filter(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
	);
	assert.match(reply.at(-1).payload.content, /model refused the request/);
});

test("/cancel aborts the running task of the invoking user", async () => {
	const harness = createHarness();
	let aborted = "";
	harness.host.abortRun = async (conversationId) => {
		aborted = conversationId;
		return { ok: true };
	};
	harness.bridge.userConversations.set(AUTHOR_ID, "c5");
	await harness.bridge.onInboundMessage(message("/cancel"));
	assert.equal(aborted, "c5");
	const reply = harness.apiCalls.filter((call) => call.method === "POST").at(-1);
	assert.match(reply.payload.content, /Cancelled the running task/);
});
