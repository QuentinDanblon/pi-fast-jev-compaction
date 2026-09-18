/**
 * Token accounting used by the measurement tools.
 *
 * pi sends the whole prompt (system prompt + tool schemas + messages), but only the messages
 * are ours to move, so the model below prices the message payload. It was validated against
 * the usage pi reports for a real 956-message session: off by -9 % there, and +31 % on an
 * image-heavy one (image cost is a flat guess, so base64-heavy sessions are the weak spot).
 *
 * The ratios are what matter: before and after are always measured on the same basis.
 */

import type { PiMessage } from "../index.ts";
import { FALLBACK_IMAGE_TOKENS, imageTokenCost } from "../image.ts";

/**
 * Token cost of one image content block.
 *
 * The base64 length says nothing about the cost, so the pixel dimensions are read from the
 * image header and priced the way vision models do it (roughly a tile grid: 750 pixels per
 * token for a full-size image, never below the ~85-token floor of a single small tile).
 * Returns undefined when the format is unknown, so callers can fall back.
 */
/** Serialised text-ish payload per token. */
export const CHARS_PER_TOKEN = 3.5;

export interface Payload {
	textChars: number;
	thinkingChars: number;
	argumentChars: number;
	detailsChars: number;
	images: number;
	imageChars: number;
	/** Token cost of the images, from their real pixel dimensions when readable. */
	imageTokens: number;
	/** Images whose header could not be read (charged at the fallback rate). */
	imagesUnknown: number;
	/** Sum of the movable text-ish payload. */
	payloadChars: number;
	/** Estimated tokens for the message payload. */
	tokens: number;
}

/**
 * Estimated tokens for the message payload.
 *
 * `countDetails` decides whether pi's tool-specific `details` metadata is priced. The
 * calibration against real provider usage is ambiguous (one session fits with details,
 * another fits without), so measurements report the conservative number that ignores them
 * and only the movable text, arguments and images are ever credited.
 */
export function measurePayload(messages: readonly PiMessage[], countDetails = true): Payload {
	const payload = rawPayload(messages);
	const counted = payload.payloadChars + (countDetails ? 0 : -payload.detailsChars);
	return { ...payload, tokens: counted / CHARS_PER_TOKEN + payload.imageTokens };
}

function rawPayload(messages: readonly PiMessage[]): Payload {
	let textChars = 0;
	let thinkingChars = 0;
	let argumentChars = 0;
	let detailsChars = 0;
	let images = 0;
	let imageChars = 0;
	let imageTokens = 0;
	let imagesUnknown = 0;
	for (const message of messages) {
		const record = message as { content?: unknown; details?: unknown; output?: string; command?: string };
		const content = record.content;
		if (typeof content === "string") textChars += content.length;
		else if (Array.isArray(content)) {
			for (const part of content as {
				type?: string;
				text?: string;
				thinking?: string;
				data?: string;
				arguments?: unknown;
			}[]) {
				if (part.type === "text") textChars += part.text?.length ?? 0;
				else if (part.type === "thinking") thinkingChars += part.thinking?.length ?? 0;
				else if (part.type === "image") {
					images += 1;
					const data = part.data ?? "";
					imageChars += data.length;
					const cost = imageTokenCost(data);
					if (cost === undefined) imagesUnknown += 1;
					imageTokens += cost ?? FALLBACK_IMAGE_TOKENS;
				} else if (part.type === "toolCall") {
					argumentChars += JSON.stringify(part.arguments ?? {}).length;
				}
			}
		}
		if (record.details !== undefined) detailsChars += JSON.stringify(record.details).length;
		if (typeof record.output === "string") textChars += record.output.length;
		if (typeof record.command === "string") textChars += record.command.length;
	}
	const payloadChars = textChars + thinkingChars + argumentChars + detailsChars;
	return {
		textChars,
		thinkingChars,
		argumentChars,
		detailsChars,
		images,
		imageChars,
		imageTokens,
		imagesUnknown,
		payloadChars,
		tokens: 0,
	};
}

/** Published prices, per million tokens, for the models this tool is usually run against. */
export const PRICE_RATIOS: Record<string, number> = {
	anthropic: 12.5, // write 1.25x input, read 0.1x input
	openai: 12.5,
	deepseek: 10,
	"flat-rate": 1, // subscription billing: an invalidation costs no money, only latency
};
