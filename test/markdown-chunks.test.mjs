import assert from "node:assert/strict";
import test from "node:test";

import { chunkMarkdownText, safeSliceIndex } from "../markdown-chunks.mjs";

test("short Markdown remains a single chunk", () => {
	assert.deepEqual(chunkMarkdownText("hello world", 100), ["hello world"]);
});

test("long Markdown is split below the requested limit", () => {
	const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
	const chunks = chunkMarkdownText(text, 80);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(chunk.length <= 80);
});

test("fenced code blocks are closed and reopened across chunks", () => {
	const text = [
		"```ts",
		"const value = 1;",
		"const anotherValue = 2;",
		"console.log(value, anotherValue);",
		"```",
	].join("\n");
	const chunks = chunkMarkdownText(text, 55);
	assert.ok(chunks.length > 1);
	assert.match(chunks[0], /```ts[\s\S]*```$/u);
	assert.match(chunks[1], /^```ts/u);
});

test("emoji surrogate pairs are not split", () => {
	const value = "a".repeat(49) + "😀" + "b".repeat(20);
	const index = safeSliceIndex(value, 50);
	assert.equal(value.charCodeAt(index - 1) >= 0xd800, false);
	assert.ok(chunkMarkdownText(value, 50).every((chunk) => !chunk.includes("�")));
});
