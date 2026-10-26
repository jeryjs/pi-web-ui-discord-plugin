import assert from "node:assert/strict";
import test from "node:test";

import { createHostRequestBridge } from "../client/host-bridge.mjs";

test("plugin host requests resolve only with the matching response", async () => {
	let onData = null;
	const sent = [];
	const bridge = createHostRequestBridge({
		send: (message) => sent.push(message),
		onData: (handler) => {
			onData = handler;
			return () => { onData = null; };
		},
	});

	const pending = bridge.send("save_config", { config: { defaultChannelId: "42" } });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, "save_config");
	assert.equal(sent[0].config.defaultChannelId, "42");
	assert.ok(sent[0].requestId);

	onData({ type: "save_config_done", requestId: "other-request", success: true });
	onData({ type: "save_config_done", requestId: sent[0].requestId, success: true });
	assert.deepEqual(await pending, {
		type: "save_config_done",
		requestId: sent[0].requestId,
		success: true,
	});
	bridge.dispose();
});

test("plugin host request errors reject with the server message", async () => {
	let onData = null;
	const sent = [];
	const bridge = createHostRequestBridge({
		send: (message) => sent.push(message),
		onData: (handler) => {
			onData = handler;
			return () => {};
		},
	});

	const pending = bridge.send("test_config");
	onData({ type: "error", requestId: sent[0].requestId, message: "Connection failed." });
	await assert.rejects(pending, /Connection failed/);
	bridge.dispose();
});

test("disposing the plugin host bridge rejects pending requests", async () => {
	const sent = [];
	const bridge = createHostRequestBridge({
		send: (message) => sent.push(message),
		onData: () => () => {},
	});
	const pending = bridge.send("get_state");
	bridge.dispose();
	await assert.rejects(pending, /closed before the request completed/);
});
