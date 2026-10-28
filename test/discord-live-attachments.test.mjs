import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DiscordBotBridge,
	appendRunActivity,
	buildAttachmentContext,
	buildRequestText,
	collectMessageAttachments,
	extractAssistantActivity,
	findLiveCut,
	isSupportedAttachmentType,
	renderRunContent,
	safeAttachmentName,
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

function createHarness({ config = baseConfig(), events = null } = {}) {
	const apiCalls = [];
	const chatCalls = [];
	let bridge;
	const host = {
		cwd: "/home/jery",
		models: { list: () => [] },
		onRunEvent: () => () => {},
		chat: async (request) => {
			chatCalls.push(request);
			setImmediate(async () => {
				for (const event of events || [
					{
						type: "message",
						conversationId: "c1",
						message: { role: "assistant", content: "the answer" },
					},
					{ type: "run_end", conversationId: "c1" },
				]) {
					await bridge.handleRunEvent(event);
				}
			});
			return { conversationId: "c1", clientId: `plugin:discord:${request.accountId}` };
		},
		conversations: { list: async () => [], get: async () => null },
		getActiveConversation: async () => null,
		abortRun: async () => ({ ok: true }),
	};
	const api = async (token, method, path, payload) => {
		apiCalls.push({ token, method, path, payload });
		if (method === "PUT") return [];
		return { id: "live-message-1", content: payload?.content || "" };
	};
	bridge = new DiscordBotBridge({
		host,
		getConfig: () => config,
		updateConfig: async (patch) => Object.assign(config, patch),
		api,
		log: () => {},
	});
	bridge.botUser = { id: BOT_ID, username: "Nero" };
	return { bridge, apiCalls, chatCalls, config };
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

function channelPosts(apiCalls) {
	return apiCalls.filter(
		(call) => call.method === "POST" && call.path === `/channels/${CHANNEL_ID}/messages`,
	);
}

test("assistant messages are reduced to thinking, tool names and text", () => {
	const activity = extractAssistantActivity({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden reasoning" },
			{ type: "toolCall", name: "bash", arguments: {} },
			{ type: "toolCall", name: "read", arguments: {} },
			{ type: "text", text: "all done" },
		],
	});
	assert.deepEqual(activity, [
		{ think: true },
		{ tool: "bash" },
		{ tool: "read" },
		{ text: "all done" },
	]);
	assert.deepEqual(extractAssistantActivity({ role: "assistant", content: "plain" }), []);
});

test("the run trace renders the steps the agent took", () => {
	const run = { segments: [] };
	for (const item of extractAssistantActivity({
		content: [
			{ type: "thinking", thinking: "hidden" },
			{ type: "toolCall", name: "bash" },
			{ type: "text", text: "first answer" },
		],
	})) {
		appendRunActivity(run, item);
	}
	assert.equal(renderRunContent(run, { showTrace: true }), "think -> bash\nfirst answer");

	// A step that starts after text was written opens a new segment.
	for (const item of extractAssistantActivity({
		content: [
			{ type: "toolCall", name: "read" },
			{ type: "text", text: "second answer" },
		],
	})) {
		appendRunActivity(run, item);
	}
	assert.equal(
		renderRunContent(run, { showTrace: true }),
		"think -> bash\nfirst answer\nread\nsecond answer",
	);
	assert.equal(renderRunContent(run, { showTrace: false }), "first answer\nsecond answer");
});

test("a live page is cut below the Discord message limit", () => {
	const text = `${"a".repeat(1200)}\n${"b".repeat(1200)}`;
	const cut = findLiveCut(text, 2000);
	assert.ok(cut <= 2000);
	assert.equal(text.slice(0, cut).endsWith("a"), true);
	assert.equal(findLiveCut("short", 2000), 5);
});

test("tool calls are only delivered when the option is enabled", async () => {
	const events = [
		{
			type: "message",
			conversationId: "c1",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash", arguments: {} },
					{ type: "text", text: "the answer" },
				],
			},
		},
		{ type: "run_end", conversationId: "c1" },
	];

	const plain = createHarness({ events });
	await plain.bridge.onInboundMessage(message("hello"));
	const plainReply = channelPosts(plain.apiCalls).at(-1);
	assert.equal(plainReply.payload.content, "the answer");
	assert.equal(plainReply.payload.content.includes("bash"), false);

	const traced = createHarness({
		config: baseConfig({ showToolCalls: true }),
		events,
	});
	await traced.bridge.onInboundMessage(message("hello"));
	const tracedReply = channelPosts(traced.apiCalls).at(-1);
	assert.match(tracedReply.payload.content, /bash/);
	assert.match(tracedReply.payload.content, /the answer/);
});

test("a streamed answer is edited in place instead of posted twice", async () => {
	const harness = createHarness({
		config: baseConfig({ liveReplyEnabled: true }),
		events: [
			{
				type: "message",
				conversationId: "c1",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "bash", arguments: {} },
						{ type: "text", text: "the answer" },
					],
				},
			},
			{ type: "run_end", conversationId: "c1" },
		],
	});
	await harness.bridge.onInboundMessage(message("hello"));

	const posts = channelPosts(harness.apiCalls);
	const patches = harness.apiCalls.filter((call) => call.method === "PATCH");
	assert.equal(posts.length, 1);
	assert.equal(patches.length, 1);
	assert.equal(patches[0].path, `/channels/${CHANNEL_ID}/messages/live-message-1`);
	assert.match(patches[0].payload.content, /the answer/);
});

test("files and custom emoji are collected from an inbound message", () => {
	const items = collectMessageAttachments({
		content: "look <:smile:123456789012345678> and <a:party:987654321098765432>",
		attachments: [
			{
				url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
				filename: "photo.png",
				content_type: "image/png",
				size: 1024,
			},
		],
	});
	assert.equal(items.length, 3);
	assert.equal(items[0].kind, "file");
	assert.equal(items[0].filename, "photo.png");
	assert.equal(items[1].kind, "emoji");
	assert.equal(items[1].filename, "emoji-smile.png");
	assert.match(items[1].url, /cdn\.discordapp\.com\/emojis\/123456789012345678\.png/);
	assert.equal(items[2].filename, "emoji-party.gif");
});

test("only attachment types the model can read are accepted", () => {
	assert.equal(isSupportedAttachmentType("image/png", "a.png"), true);
	assert.equal(isSupportedAttachmentType("image/svg+xml", "a.svg"), false);
	assert.equal(isSupportedAttachmentType("text/plain", "a.txt"), true);
	assert.equal(isSupportedAttachmentType("application/json", "a.json"), true);
	assert.equal(isSupportedAttachmentType("application/octet-stream", "a.bin"), false);
	assert.equal(isSupportedAttachmentType("", "main.py"), true);
});

test("attachment names cannot escape the download folder", () => {
	assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
	assert.equal(safeAttachmentName("photo.png"), "photo.png");
	assert.equal(safeAttachmentName(""), "attachment");
	assert.equal(safeAttachmentName("weird name!.txt"), "weird name_.txt");
});

test("the attachment context lists the files the model can read", () => {
	const context = buildAttachmentContext(
		[
			{
				kind: "file",
				filename: "photo.png",
				contentType: "image/png",
				path: "/workspace/.pi-web-discord/attachments/1/photo.png",
			},
		],
		[{ filename: "archive.bin" }],
	);
	assert.match(context, /<discord_attachments>/);
	assert.match(context, /photo\.png/);
	assert.match(context, /\/workspace\/\.pi-web-discord\/attachments\/1\/photo\.png/);
	assert.match(context, /archive\.bin/);
	assert.equal(buildAttachmentContext([], []), "");
});

test("the request text carries the attachment block", () => {
	const text = buildRequestText({
		text: "what is in this file?",
		config: baseConfig(),
		attachments: buildAttachmentContext([
			{ kind: "file", filename: "notes.md", contentType: "text/markdown", path: "/w/notes.md" },
		]),
	});
	assert.match(text, /<discord_attachments>/);
	assert.match(text, /\/w\/notes\.md/);
	assert.match(text, /<discord_user_message>\nwhat is in this file\?\n<\/discord_user_message>/);
});

test("attachments are downloaded into the workspace and handed to the model", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-web-discord-"));
	const originalFetch = globalThis.fetch;
	const fetched = [];
	globalThis.fetch = async (url) => {
		fetched.push(String(url));
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer,
		};
	};
	try {
		const harness = createHarness({
			config: baseConfig({ allowAttachments: true, workspace }),
		});
		await harness.bridge.onInboundMessage(
			message("what is this?", {
				attachments: [
					{
						url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
						filename: "photo.png",
						content_type: "image/png",
						size: 16,
					},
				],
			}),
		);
		const request = harness.chatCalls[0];
		const expected = join(
			workspace,
			AUTHOR_ID,
			".pi-web-discord",
			"attachments",
			"user-message-1",
			"photo.png",
		);
		assert.match(request.text, /<discord_attachments>/);
		assert.ok(request.text.includes(expected), `expected ${expected} in the request text`);
		assert.equal(await readFile(expected, "utf8"), "fake-image-bytes");
		assert.equal(fetched.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(workspace, { recursive: true, force: true });
	}
});

test("attachments are ignored unless the option is enabled", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-web-discord-"));
	const originalFetch = globalThis.fetch;
	let fetched = 0;
	globalThis.fetch = async () => {
		fetched += 1;
		return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
	};
	try {
		const harness = createHarness({ config: baseConfig({ workspace }) });
		await harness.bridge.onInboundMessage(
			message("what is this?", {
				attachments: [
					{
						url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
						filename: "photo.png",
						content_type: "image/png",
						size: 16,
					},
				],
			}),
		);
		assert.equal(fetched, 0);
		assert.equal(harness.chatCalls[0].text.includes("<discord_attachments>"), false);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(workspace, { recursive: true, force: true });
	}
});
