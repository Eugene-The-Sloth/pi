import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

const context: Context = {
	systemPrompt: "Regular system prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	apiKey: string,
	compat?: Model<"anthropic-messages">["compat"],
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`, compat), context, {
			apiKey,
			cacheRetention: "none",
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

function systemTexts(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.system)) return [];
	return body.system.flatMap((block) => {
		if (typeof block !== "object" || block === null) return [];
		const text = (block as { text?: unknown }).text;
		return typeof text === "string" ? [text] : [];
	});
}

describe("Anthropic auth mode compatibility", () => {
	it("forces OAuth Bearer auth for non-Anthropic token prefixes", async () => {
		const request = await captureAnthropicRequest("proxy-oauth-token", { authMode: "oauth" });

		expect(request.headers.authorization).toBe("Bearer proxy-oauth-token");
		expect(request.headers["x-api-key"]).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
		expect(systemTexts(request.body)[0]).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
	});

	it("forces API-key auth for Anthropic OAuth-looking tokens", async () => {
		const request = await captureAnthropicRequest("sk-ant-oat-forced-api-key", { authMode: "apiKey" });

		expect(request.headers["x-api-key"]).toBe("sk-ant-oat-forced-api-key");
		expect(request.headers.authorization).toBeUndefined();
		expect(systemTexts(request.body)).toEqual(["Regular system prompt."]);
	});

	it("keeps prefix-based OAuth detection in auto mode", async () => {
		const oauthRequest = await captureAnthropicRequest("sk-ant-oat-auto", { authMode: "auto" });
		const apiKeyRequest = await captureAnthropicRequest("plain-api-key");

		expect(oauthRequest.headers.authorization).toBe("Bearer sk-ant-oat-auto");
		expect(oauthRequest.headers["x-api-key"]).toBeUndefined();
		expect(apiKeyRequest.headers["x-api-key"]).toBe("plain-api-key");
		expect(apiKeyRequest.headers.authorization).toBeUndefined();
	});
});
