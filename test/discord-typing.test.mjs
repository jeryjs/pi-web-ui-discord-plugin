import assert from "node:assert/strict";
import test from "node:test";

import { DISCORD_COMMANDS, DiscordBotBridge } from "../index.mjs";

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
		useWorkspaceSession: false,
		...overrides,
	};
}

function createHarness({ config = baseConfig(), hostChat, failTyping = false } = {}) {
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
		conversations: { list: async () => [], get: async () => null },
		getActiveConversation: async () => null,
		abortRun: async () => ({ ok: true }),
	};
	const api = async (token, method, path, payload) => {
		apiCalls.push({ token, method, path, payload });
		if (method === "PUT") return DISCORD_COMMANDS;
		if (path.endsWith("/typing") && failTyping) {
			throw new Error("403 Forbidden");
		}
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

function typingCalls(apiCalls) {
	return apiCalls.filter(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/typing`,
	);
}

test("the typing indicator starts when the turn is dispatched", async () => {
	const harness = createHarness();
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	const calls = typingCalls(harness.apiCalls);
	assert.equal(calls.length, 1);
	// The indicator is requested before the agent answers.
	const reply = harness.apiCalls.find(
		(call) => call.method === "POST" && call.path.endsWith("/messages"),
	);
	assert.ok(reply);
	assert.ok(harness.apiCalls.indexOf(calls[0]) < harness.apiCalls.indexOf(reply));
});

test("the typing indicator is stopped once the answer is delivered", async () => {
	const harness = createHarness();
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	assert.equal(harness.bridge.typingIndicators.size, 0);
	assert.equal(harness.bridge.getStatus().typingChannels, 0);
});

test("the typing indicator is refreshed while the agent works", (t) => {
	const harness = createHarness();
	const run = harness.bridge.createRun({ channelId: CHANNEL_ID, authorId: AUTHOR_ID });
	t.mock.timers.enable({ apis: ["setInterval"] });
	harness.bridge.startTypingIndicator(run, harness.config);
	assert.equal(typingCalls(harness.apiCalls).length, 1);
	t.mock.timers.tick(8_000);
	assert.equal(typingCalls(harness.apiCalls).length, 2);
	t.mock.timers.tick(8_000);
	assert.equal(typingCalls(harness.apiCalls).length, 3);
	harness.bridge.stopTypingIndicator(run);
	t.mock.timers.tick(30_000);
	assert.equal(typingCalls(harness.apiCalls).length, 3);
	assert.equal(harness.bridge.typingIndicators.size, 0);
});

test("a failing typing request never breaks the turn", async () => {
	const harness = createHarness({ failTyping: true });
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	const reply = harness.apiCalls.find(
		(call) => call.method === "POST" && call.path.endsWith("/messages"),
	);
	assert.ok(reply);
	assert.equal(reply.payload.content, "ok");
});

test("the typing indicator can be switched off", async () => {
	const harness = createHarness({ config: baseConfig({ typingIndicator: false }) });
	await harness.bridge.onInboundMessage(dmMessage("hello"));
	assert.equal(typingCalls(harness.apiCalls).length, 0);
	const reply = harness.apiCalls.find(
		(call) => call.method === "POST" && call.path.endsWith("/messages"),
	);
	assert.ok(reply);
});
