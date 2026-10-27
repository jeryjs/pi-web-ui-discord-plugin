/**
 * Correlate fire-and-forget plugin host messages with their responses.
 *
 * pi-web-ui's client `context.send()` only transmits a message; replies arrive
 * asynchronously through `context.onData()`. Bundled pi-web-ui plugins pair
 * those replies with a `__rid` token, while some builds echo `requestId`, so
 * this bridge sends both tokens and accepts either one on the way back.
 */
export function createHostRequestBridge(context, { timeoutMs = 15_000 } = {}) {
	if (typeof context?.send !== "function" || typeof context?.onData !== "function") {
		throw new Error("The pi-web-ui plugin messaging bridge is unavailable.");
	}

	const pending = new Map();
	let sequence = 0;

	const unsubscribe = context.onData((payload) => {
		const requestId = String(payload?.__rid || payload?.requestId || "").trim();
		if (!requestId) return;
		const waiter = pending.get(requestId);
		if (!waiter) return;
		pending.delete(requestId);
		clearTimeout(waiter.timer);
		if (payload?.type === "error") {
			waiter.reject(new Error(payload?.message || "The plugin request failed."));
			return;
		}
		waiter.resolve(payload);
	});

	function send(type, payload = {}) {
		const requestId = `discord-${Date.now()}-${++sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(`The plugin request "${type}" timed out.`));
			}, timeoutMs);
			pending.set(requestId, { resolve, reject, timer });
			try {
				context.send({ ...payload, type, __rid: requestId, requestId });
			} catch (error) {
				pending.delete(requestId);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	function dispose() {
		for (const [requestId, waiter] of pending) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("The plugin view was closed before the request completed."));
			pending.delete(requestId);
		}
		try {
			unsubscribe?.();
		} catch {}
	}

	return { send, dispose };
}
