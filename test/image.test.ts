/** Image pricing: the base64 length must never be mistaken for the cost. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageDimensions, imageNote, imageTokenCost } from "../image.ts";

/** Smallest possible PNG header carrying the given dimensions. */
function png(width: number, height: number): string {
	const bytes = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	Buffer.from("IHDR").copy(bytes, 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes.toString("base64");
}

/** Minimal but well-formed JPEG: SOI, APP0 (declared length 4), then a SOF0 frame header. */
function jpeg(width: number, height: number): string {
	const bytes = Buffer.alloc(20);
	bytes.writeUInt16BE(0xffd8, 0); // SOI
	bytes.writeUInt16BE(0xffe0, 2); // APP0 marker
	bytes.writeUInt16BE(4, 4); // segment length, including these two bytes
	bytes.writeUInt16BE(0, 6); // the two payload bytes the length promises
	bytes.writeUInt16BE(0xffc0, 8); // SOF0
	bytes.writeUInt16BE(11, 10); // frame header length
	bytes.writeUInt8(8, 12); // precision
	bytes.writeUInt16BE(height, 13);
	bytes.writeUInt16BE(width, 15);
	bytes.writeUInt8(3, 17); // component count
	return bytes.toString("base64");
}

test("image dimensions come from the header, not the payload size", () => {
	assert.deepEqual(imageDimensions(png(1704, 1307)), { width: 1704, height: 1307 });
	assert.deepEqual(imageDimensions(jpeg(1440, 900)), { width: 1440, height: 900 });
	assert.equal(imageDimensions("bm90IGFuIGltYWdl"), undefined, "garbage is rejected");
	assert.equal(imageDimensions(""), undefined);
});

test("an image is priced by its pixels, the way providers do", () => {
	// 1704x1307 is downscaled to 1568x1202 and priced at ~750 pixels per token.
	const cost = imageTokenCost(png(1704, 1307));
	assert.ok(cost !== undefined && cost > 2300 && cost < 2700, `unexpected cost ${cost}`);
	// A small image is cheap, and never below the single-tile floor.
	assert.ok((imageTokenCost(png(200, 120)) ?? 0) >= 85);
	// Twice the pixels is twice the cost.
	const half = imageTokenCost(png(784, 601)) ?? 0;
	const full = imageTokenCost(png(1568, 1202)) ?? 0;
	assert.ok(full > half * 3.5 && full < half * 4.5, `${half} vs ${full}`);
	assert.equal(imageTokenCost("bm90IGFuIGltYWdl"), undefined);
});

test("a model is told what an image costs, never its base64", () => {
	const note = imageNote(png(1704, 1307), "image/png");
	assert.match(note, /^\[image 1704x1307, ~2\d{3} tokens\]$/);
	assert.ok(note.length < 60, "the note stays short");
	assert.doesNotMatch(note, /iVBOR/);
	assert.match(imageNote("bm90IGFuIGltYWdl", "image/webp"), /^\[image image\/webp, size unknown\]$/);
});
