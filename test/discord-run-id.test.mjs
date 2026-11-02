import assert from "node:assert/strict";
import test from "node:test";

import { DISCORD_COMMANDS, DiscordBotBridge, sessionKey, sessionScope } from "../index.mjs";

const AUTHOR_ID = "401364668204099585";
const BOT_ID = "999999999999999999";
const CHANNEL_ID = "1031955437005848616";
const GUILD_ID = "guild-1";

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

function createHarness({ config = baseConfig(), hostChat } = {}) {
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
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
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
	return { bridge, apiCalls, chatCalls, config, host };
}

function message(text, overrides = {}) {
	return {
		id: "user-message-1",
		channel_id: CHANNEL_ID,
		guild_id: GUILD_ID,
		author: { id: AUTHOR_ID, bot: false },
		content: text,
		mentions: [{ id: BOT_ID }],
		...overrides,
	};
}

function replies(harness) {
	return harness.apiCalls.filter(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
	);
}

const SCOPE_KEY = sessionKey(sessionScope({ guildId: GUILD_ID, channelId: CHANNEL_ID }), AUTHOR_ID);

test("the stable run id of the receipt claims the turn", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					runId: "pr-1",
					at: Date.now(),
					message: { role: "assistant", content: "the answer" },
				});
				await bridge.handleRunEvent({
					type: "run_end",
					conversationId: "c1",
					runId: "pr-1",
					at: Date.now(),
				});
			});
			return {
				conversationId: "c1",
				clientId: `plugin:discord:${request.accountId}`,
				runId: "pr-1",
			};
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	assert.equal(replies(harness).at(-1).payload.content, "the answer");
});

test("a turn survives the host moving the conversation to another id", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				// The host transferred the turn and renamed the conversation.
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c2",
					runId: "pr-1",
					at: Date.now(),
					message: { role: "assistant", content: "the transferred answer" },
				});
				await bridge.handleRunEvent({
					type: "run_end",
					conversationId: "c2",
					runId: "pr-1",
					at: Date.now(),
				});
			});
			return {
				conversationId: "c1",
				clientId: `plugin:discord:${request.accountId}`,
				runId: "pr-1",
			};
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	assert.equal(replies(harness).at(-1).payload.content, "the transferred answer");
	// The remembered session follows the conversation that exists now.
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(harness.config.userSessions?.[SCOPE_KEY]?.conversationId, "c2");
});

test("an event of another run id is not shipped to Discord", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				// Another plugin owns this turn.
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					runId: "pr-other",
					at: Date.now(),
					message: { role: "assistant", content: "answer for somebody else" },
				});
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					runId: "pr-ours",
					at: Date.now(),
					message: { role: "assistant", content: "our answer" },
				});
				await bridge.handleRunEvent({
					type: "run_end",
					conversationId: "c1",
					runId: "pr-ours",
					at: Date.now(),
				});
			});
			return {
				conversationId: "c1",
				clientId: `plugin:discord:${request.accountId}`,
				runId: "pr-ours",
			};
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	const reply = replies(harness).at(-1);
	assert.equal(reply.payload.content, "our answer");
});

test("a host without stable run ids keeps working", async () => {
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			setImmediate(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "c1",
					at: Date.now(),
					message: { role: "assistant", content: "the answer" },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "c1", at: Date.now() });
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
	});
	await harness.bridge.onInboundMessage(message("hello"));
	assert.equal(replies(harness).at(-1).payload.content, "the answer");
	assert.equal(harness.bridge.runIdIndex.size, 0);
});

test("the run id mapping points at the pending run and is dropped afterwards", async () => {
	let bridgeRef = null;
	const harness = createHarness({
		hostChat: async (request, bridge) => {
			bridgeRef = bridge;
			return {
				conversationId: "c1",
				clientId: `plugin:discord:${request.accountId}`,
				runId: "pr-1",
			};
		},
	});
	// The turn never ends on its own here, so the dispatch stays pending.
	const turn = harness.bridge.onInboundMessage(message("hello"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(bridgeRef.runIdIndex.get("pr-1"), "c1");
	const run = bridgeRef.findRunForEvent({ conversationId: "unknown", runId: "pr-1" });
	assert.ok(run);
	assert.equal(run.hostRunId, "pr-1");
	await bridgeRef.finishRun(run);
	assert.equal(bridgeRef.runIdIndex.size, 0);
	await turn;
});
