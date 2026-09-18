/**
 * What an image content block costs, and how to describe it to a model.
 *
 * The base64 length says nothing about the cost: a 1704x1307 screenshot is roughly 2500 tokens
 * whether it arrives as PNG or JPEG. Everything here reads only the container header, so no
 * image is ever decoded, and the numbers match how vision providers charge (downscale the long
 * side to 1568 px, then ~750 pixels per token).
 */

/** Long side above which providers downscale before pricing. */
export const MAX_IMAGE_SIDE = 1568;

/** Pixels per token for a vision image. */
export const PIXELS_PER_TOKEN = 750;

/** Charged for an image whose header cannot be read. */
export const FALLBACK_IMAGE_TOKENS = 1200;

/** Width and height from a PNG, JPEG, GIF or WebP header, without decoding the image. */
export function imageDimensions(base64: string): { width: number; height: number } | undefined {
	let bytes: Buffer;
	try {
		bytes = Buffer.from(base64.slice(0, 40_000), "base64");
	} catch {
		return undefined;
	}
	if (bytes.length < 16) return undefined;
	// PNG: IHDR chunk starts at byte 8; width and height are 4-byte big-endian at 16 and 20.
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	// GIF: little-endian 16-bit at 6 and 8.
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	}
	// JPEG: walk the segment markers up to the frame header (SOF0..SOF15, minus DHT/DAC/RST).
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = bytes[offset + 1];
			if (marker === undefined) break;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
			}
			const length = bytes.readUInt16BE(offset + 2);
			if (length <= 0) break;
			offset += 2 + length;
		}
		return undefined;
	}
	// WebP: lossy VP8, lossless VP8L, extended VP8X.
	if (base64.startsWith("UklGR")) {
		const chunk = base64.slice(12, 16);
		if (chunk === "VP8L" && bytes.length > 25) {
			const bits = bytes.readUInt32LE(21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8 " && bytes.length > 30) {
			return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
		}
		if (chunk === "VP8X" && bytes.length > 30) {
			const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
			const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
			return { width, height };
		}
	}
	return undefined;
}

/**
 * Token cost of one image, or undefined when its header cannot be read.
 *
 * Measured on the real screenshots in these sessions: 1704x1307 -> ~2500 tokens.
 */
export function imageTokenCost(base64: string): number | undefined {
	const dimensions = imageDimensions(base64);
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return undefined;
	const longest = Math.max(dimensions.width, dimensions.height);
	const scale = longest > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / longest : 1;
	const pixels = dimensions.width * scale * (dimensions.height * scale);
	return Math.max(85, Math.min(3000, Math.round(pixels / PIXELS_PER_TOKEN)));
}

/** How an image is described to a model: its real size and cost, never the base64 payload. */
export function imageNote(data: string, mimeType: string): string {
	const size = imageDimensions(data);
	const cost = imageTokenCost(data);
	const detail =
		size && cost !== undefined
			? `${size.width}x${size.height}, ~${cost} tokens`
			: `${mimeType}, size unknown`;
	return `[image ${detail}]`;
}
