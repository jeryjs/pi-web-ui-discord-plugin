/**
 * Structure-aware Markdown chunking for Discord's 2,000-character message limit.
 *
 * This file is intentionally self-contained so the repository can be installed as
 * a standalone pi-web-ui plugin without depending on pi-web-ui's plugin-sdk path.
 */

const DEFAULT_CHUNK_LIMIT = 3800;
const CODE_FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Return a slice boundary that never splits a UTF-16 surrogate pair. */
export function safeSliceIndex(value, limit) {
	let index = Math.min(limit, value.length);
	if (index <= 0) return 0;
	const before = value.charCodeAt(index - 1);
	const after = value.charCodeAt(index);
	if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
		index -= 1;
	}
	return Math.max(1, index);
}

function openingFence(line) {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	const match = CODE_FENCE_OPEN.exec(normalized);
	if (!match) return null;
	if (match[2][0] === "`" && match[3].includes("`")) return null;
	return { delimiter: match[2], info: match[3], indent: match[1].length };
}

function closesFence(line, opening) {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return Boolean(match && match[1][0] === opening.delimiter[0] && match[1].length >= opening.delimiter.length);
}

function splitRawText(text, limit) {
	if (text.length <= limit) return [text];
	const parts = [];
	let remaining = text;
	while (remaining.length > limit) {
		let index = safeSliceIndex(remaining, limit);
		const newline = remaining.lastIndexOf("\n", index - 1);
		if (newline >= 0 && newline >= Math.floor(limit * 0.4)) {
			index = newline + 1;
		}
		parts.push(remaining.slice(0, index));
		remaining = remaining.slice(index);
	}
	if (remaining || parts.length === 0) parts.push(remaining);
	return parts;
}

/**
 * Split Markdown without breaking fenced code blocks.
 *
 * When a fence crosses a chunk boundary, the previous chunk is closed and the
 * next chunk reopens it with the original info string.
 */
export function chunkMarkdownText(text, limit = DEFAULT_CHUNK_LIMIT) {
	const raw = String(text ?? "").trim();
	if (!raw) return [];
	const bound = Math.max(50, Number(limit) || DEFAULT_CHUNK_LIMIT);
	if (raw.length <= bound) return [raw];

	const lines = raw.split("\n");
	const chunks = [];
	let currentLines = [];
	let currentLen = 0;
	let activeFence = null;

	function flushChunk() {
		if (currentLines.length === 0) return;
		if (activeFence) {
			currentLines.push(activeFence.delimiter);
			chunks.push(currentLines.join("\n"));
			currentLines = [`${activeFence.delimiter}${activeFence.info}`];
			currentLen = currentLines[0].length + 1;
		} else {
			chunks.push(currentLines.join("\n"));
			currentLines = [];
			currentLen = 0;
		}
	}

	for (const line of lines) {
		const lineLen = line.length + 1;

		if (activeFence) {
			if (closesFence(line, activeFence)) activeFence = null;
		} else {
			const open = openingFence(line);
			if (open) activeFence = open;
		}

		if (currentLen + lineLen > bound) {
			if (currentLines.length === 0) {
				const parts = splitRawText(line, bound - (activeFence ? 20 : 0));
				for (let index = 0; index < parts.length; index++) {
					currentLines.push(parts[index]);
					if (index < parts.length - 1) flushChunk();
				}
				currentLen = currentLines.join("\n").length + 1;
				continue;
			}
			flushChunk();
		}

		currentLines.push(line);
		currentLen += lineLen;
	}

	if (currentLines.length > 0) chunks.push(currentLines.join("\n"));
	return chunks;
}
