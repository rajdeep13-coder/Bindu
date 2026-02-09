/**
 * Bindu A2A Protocol Endpoint Adapter
 * Translates between chat-ui's internal format and Bindu's JSON-RPC A2A protocol
 */

import { z } from "zod";
import { config } from "$lib/server/config";
import type { Endpoint, EndpointMessage } from "../endpoints";
import { binduResponseToStream } from "./binduToTextGenerationStream";
import type { 
	BinduMessage, 
	Part, 
	MessageSendParams, 
	BinduJsonRpcRequest,
	Task,
	PaymentSessionResponse,
	PaymentStatusResponse,
	TaskState
} from "./types";
import { TERMINAL_STATES, NON_TERMINAL_STATES, WORKING_STATES } from "./types";

export const endpointBinduParametersSchema = z.object({
	type: z.literal("bindu"),
	baseURL: z.string().url(),
	apiKey: z.string().optional().default(""),
	paymentToken: z.string().optional().default(""),
	streamingSupported: z.boolean().default(true),
});

/**
 * Convert chat-ui message format to Bindu message parts
 */
function messageContentToParts(message: EndpointMessage): Part[] {
	const parts: Part[] = [];

	// Handle string content
	if (typeof message.content === "string") {
		parts.push({ kind: "text", text: message.content });
	}

	// Handle file attachments if present
	if (message.files && message.files.length > 0) {
		for (const file of message.files) {
			if (file.type === "base64") {
				parts.push({
					kind: "file",
					file: {
						name: file.name,
						mimeType: file.mime,
						bytes: file.value,
					},
				});
			}
		}
	}

	return parts;
}

/**
 * Build the complete message history for context
 * Tracks task IDs and states for proper task continuity
 */
function buildMessageHistory(
	messages: EndpointMessage[],
	contextId: string
): { lastMessage: BinduMessage; history: BinduMessage[]; lastTaskId?: string; lastTaskState?: string } {
	const history: BinduMessage[] = [];
	let lastTaskId: string | undefined;
	let lastTaskState: string | undefined;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const taskId = crypto.randomUUID();
		const binduMsg: BinduMessage = {
			role: msg.from === "assistant" ? "agent" : "user",
			parts: messageContentToParts(msg),
			kind: "message",
			messageId: crypto.randomUUID(),
			contextId,
			taskId,
		};
		history.push(binduMsg);
		
		// Track last user message's task ID for continuity
		if (msg.from === "user") {
			lastTaskId = taskId;
		}
	}

	const lastMessage = history[history.length - 1];
	return { lastMessage, history: history.slice(0, -1), lastTaskId, lastTaskState };
}

/**
 * Create the Bindu endpoint handler
 */
export async function endpointBindu(
	input: z.input<typeof endpointBinduParametersSchema>
): Promise<Endpoint> {
	const { baseURL, apiKey, streamingSupported } = endpointBinduParametersSchema.parse(input);

	// Use configured API key or fall back to environment variable
	const effectiveApiKey = apiKey || config.BINDU_API_KEY || "";

	return async ({ messages, conversationId, preprompt, abortSignal }) => {
		// Filter to get actual user/assistant messages
		const conversationMessages = messages.filter(
			(m) => m.from === "user" || m.from === "assistant"
		);

		if (conversationMessages.length === 0) {
			throw new Error("No messages to send to Bindu agent");
		}

		// Use conversation ID as context ID for continuity
		// Convert MongoDB ObjectId (24 chars) to UUID format (32 chars hex)
		const contextId = conversationId 
			? conversationId.toString().padEnd(32, '0')  // Pad to 32 chars for UUID format
			: crypto.randomUUID();
		const taskId = crypto.randomUUID();

		// Build message with history
		const { lastMessage } = buildMessageHistory(conversationMessages, contextId);

		// Override taskId for the actual request
		lastMessage.taskId = taskId;

		// Prepare system prompt as part of configuration if present
		const systemContext = preprompt?.trim()
			? { systemPrompt: preprompt.trim() }
			: {};

		// Build JSON-RPC request params
		const params: MessageSendParams = {
			message: lastMessage,
			configuration: {
				acceptedOutputModes: ["text/plain", "application/json"],
				blocking: false,  // Use async task pattern
				...systemContext,
			},
		};

		// Step 1: Send message (returns task immediately)
		const messageRequest: BinduJsonRpcRequest = {
			jsonrpc: "2.0",
			method: "message/send",
			params: params as unknown as Record<string, unknown>,
			id: crypto.randomUUID(),
		};

		// Build headers
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (effectiveApiKey) {
			headers["Authorization"] = `Bearer ${effectiveApiKey}`;
		}

		// Step 1: Send message (returns task immediately)
		const messageResponse = await fetch(baseURL, {
			method: "POST",
			headers,
			body: JSON.stringify(messageRequest),
			signal: abortSignal,
		});

		if (!messageResponse.ok) {
			const errorText = await messageResponse.text().catch(() => "Unknown error");
			throw new Error(
				`Message send failed: ${messageResponse.status} ${messageResponse.statusText} - ${errorText}`
			);
		}

		const messageResult = await messageResponse.json();
		if (messageResult.error) {
			throw new Error(`Message send error: ${messageResult.error.message}`);
		}

		// Extract task from result - result IS the task directly
		const initialTask = messageResult.result;
		if (!initialTask || !initialTask.id) {
			throw new Error("No task returned from message/send");
		}
		const submittedTaskId = initialTask.id;

		// Step 2: Poll for task completion
		const pollInterval = 1000; // Poll every 1 second (matches legacy UI)
		const maxAttempts = 300; // Max 5 minutes (300 * 1000ms)
		
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (abortSignal?.aborted) {
				throw new Error("Request aborted");
			}

			// Wait before polling
			if (attempt > 0) {
				await new Promise(resolve => setTimeout(resolve, pollInterval));
			}

			// Get task status
			const statusRequest: BinduJsonRpcRequest = {
				jsonrpc: "2.0",
				method: "tasks/get",
				params: { taskId: submittedTaskId },
				id: crypto.randomUUID(),
			};

			const statusResponse = await fetch(baseURL, {
				method: "POST",
				headers,
				body: JSON.stringify(statusRequest),
				signal: abortSignal,
			});

			if (!statusResponse.ok) {
				continue; // Retry on error
			}

			const statusResult = await statusResponse.json();
			
			if (statusResult.error) {
				throw new Error(`Task status error: ${statusResult.error.message}`);
			}

			// Result IS the task directly
			const task = statusResult.result;
			if (!task || !task.status) {
				continue; // Task not ready yet
			}

			const taskState = task.status.state;
			
			// Check if task is complete
			if (taskState === "completed" || taskState === "input-required") {
				// Convert the completed task result to a stream
				// Create a mock Response with the JSON result
				const mockResponse = new Response(JSON.stringify(statusResult), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
				return binduResponseToStream(mockResponse);
			} else if (taskState === "failed" || taskState === "canceled") {
				throw new Error(`Task ${taskState}: ${task.status?.message || "Unknown error"}`);
			}
			// Otherwise continue polling (working, submitted, etc.)
		}

		throw new Error("Task polling timeout - task did not complete in time");
	};
}
