# Existing Chat Conversation Architecture

## Overview

The existing chat system in the Bindu frontend follows a **server-side streaming architecture** where the frontend sends requests to SvelteKit API routes, which then call LLM endpoints and stream responses back.

## Architecture Flow

```
User Input → ChatWindow Component → +page.svelte → +server.ts (API Route) 
→ textGeneration() → LLM Endpoint → Stream Response → Frontend Updates
```

## Key Components

### 1. Frontend Page (`/routes/conversation/[id]/+page.svelte`)

**Purpose**: Main conversation page that manages message state and user interactions

**Key Functions**:
- `writeMessage()` - Sends user message to backend
- `onMessage()` - Handler when user submits a message
- `onRetry()` - Handler for retrying failed messages
- `stopGeneration()` - Aborts ongoing generation

**Message Flow**:
```typescript
async function writeMessage({ prompt, messageId, isRetry }) {
  // 1. Create user message and empty assistant message in local state
  const newUserMessageId = addChildren(conv, { from: "user", content: prompt });
  const messageToWriteToId = addChildren(conv, { from: "assistant", content: "" });
  
  // 2. Call backend API with streaming
  const messageUpdatesIterator = await fetchMessageUpdates(
    conversationId,
    { inputs: prompt, messageId, isRetry, files },
    abortSignal
  );
  
  // 3. Process streaming updates
  for await (const update of messageUpdatesIterator) {
    if (update.type === 'stream') {
      messageToWriteTo.content += update.token; // Append tokens
    } else if (update.type === 'finalAnswer') {
      // Generation complete
    }
  }
}
```

### 2. Message Updates Utility (`/lib/utils/messageUpdates.ts`)

**Purpose**: Handles streaming communication with backend

**Key Function**: `fetchMessageUpdates()`
```typescript
export async function fetchMessageUpdates(
  conversationId: string,
  opts: { inputs, messageId, isRetry, files, ... },
  abortSignal: AbortSignal
): Promise<AsyncGenerator<MessageUpdate>>
```

**What it does**:
1. Sends POST request to `/conversation/{id}` endpoint
2. Receives streaming response (newline-delimited JSON)
3. Parses each line as a `MessageUpdate` object
4. Yields updates to caller

**MessageUpdate Types**:
- `stream` - Token from LLM (partial response)
- `status` - Status updates (started, error, etc.)
- `tool` - Tool call updates (for MCP/function calling)
- `finalAnswer` - Generation complete
- `title` - Conversation title generated

### 3. Backend API Route (`/routes/conversation/[id]/+server.ts`)

**Purpose**: Server-side endpoint that handles message generation

**Flow**:
```typescript
export async function POST({ request, locals, params }) {
  // 1. Validate user and conversation access
  const conv = await collections.conversations.findOne({ _id: convId });
  
  // 2. Add user message and empty assistant message to database
  const newUserMessageId = addChildren(conv, { from: "user", content: prompt });
  const messageToWriteToId = addChildren(conv, { from: "assistant", content: "" });
  
  // 3. Build prompt from conversation history
  const messagesForPrompt = buildSubtree(conv, newUserMessageId);
  
  // 4. Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      // 5. Call textGeneration() which yields MessageUpdate objects
      for await (const update of textGeneration(ctx)) {
        // Update message content in database
        if (update.type === 'stream') {
          messageToWriteTo.content += update.token;
        }
        
        // Send update to frontend
        controller.enqueue(JSON.stringify(update) + '\n');
      }
    }
  });
  
  return new Response(stream);
}
```

### 4. Text Generation (`/lib/server/textGeneration/index.ts`)

**Purpose**: Orchestrates LLM generation with MCP tools and title generation

```typescript
export async function* textGeneration(ctx: TextGenerationContext) {
  // Merge multiple generators:
  // 1. Title generation (runs in parallel)
  // 2. Text generation with MCP tools
  // 3. Keep-alive pings
  
  yield* mergeAsyncGenerators([
    generateTitleForConversation(ctx.conv),
    textGenerationWithoutTitle(ctx),
    keepAlive()
  ]);
}
```

**Text Generation Flow**:
1. Try MCP tool flow first (if tools selected)
2. Fall back to default LLM generation
3. Call `generate()` which calls the LLM endpoint

### 5. LLM Endpoint (`/lib/server/endpoints/`)

**Purpose**: Adapters for different LLM providers (OpenAI, Bindu, etc.)

**Example - OpenAI Endpoint**:
```typescript
export const endpointOai = {
  async *generate({ messages, preprompt, generateSettings }) {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messages,
      stream: true
    });
    
    // Convert OpenAI stream to TextGenerationStreamOutput
    yield* openAIChatToTextGenerationStream(response);
  }
}
```

**Bindu Endpoint** (`endpoints/bindu/endpointBindu.ts`):
- Makes JSON-RPC calls to Bindu agent API
- Converts Bindu responses to `TextGenerationStreamOutput`
- Already exists but not used in conversation flow

## Data Structures

### Message
```typescript
interface Message {
  id: string;
  from: "user" | "assistant";
  content: string;
  files?: MessageFile[];
  updates?: MessageUpdate[];  // Streaming updates
  children: string[];         // Child message IDs (tree structure)
  ancestors?: string[];       // Parent message IDs
}
```

### MessageUpdate
```typescript
type MessageUpdate = 
  | { type: "stream"; token: string }
  | { type: "status"; status: "started" | "error" | "keepAlive" }
  | { type: "finalAnswer"; text?: string; interrupted?: boolean }
  | { type: "title"; title: string }
  | { type: "tool"; subtype: "call" | "result" | "error"; ... }
```

### Conversation
```typescript
interface Conversation {
  _id: ObjectId;
  messages: Message[];  // Tree structure
  rootMessageId?: string;
  model: string;
  title?: string;
}
```

## Message Tree Structure

Conversations use a **tree structure** to support:
- Message editing (creates sibling branch)
- Regeneration (creates sibling assistant response)
- Multiple conversation paths

```
Root Message (user)
  ├─ Assistant Response 1
  │   └─ User Follow-up
  │       └─ Assistant Response
  └─ Assistant Response 2 (regenerated)
```

**Helper Functions**:
- `addChildren()` - Add child message to parent
- `addSibling()` - Add sibling message (for edits/regeneration)
- `buildSubtree()` - Build linear prompt from tree path
- `createMessagesPath()` - Extract linear path from tree for display

## ChatWindow Component

**Purpose**: Reusable chat UI component

**Props**:
```typescript
{
  messages: Message[];
  loading: boolean;
  onmessage: (content: string) => void;
  onretry: (payload) => void;
  onstop: () => void;
  currentModel: Model;
}
```

**Features**:
- Message display with markdown rendering
- File upload support
- Voice recording (transcription)
- Stop generation button
- Retry/regenerate buttons
- Model selector

## Where to Integrate Agent API

### Option 1: Add Bindu Agent as a Model

**Approach**: Add "Bindu Agent" to the model list, use existing endpoint

**Changes Needed**:
1. Add Bindu agent to models list in `+page.ts` or server config
2. Ensure `endpointBindu.ts` is configured correctly
3. Set model to use Bindu endpoint

**Pros**: Minimal changes, uses existing architecture
**Cons**: Requires model configuration

### Option 2: Conditional API Call in fetchMessageUpdates

**Approach**: Check if using agent mode, call agent API directly

**Changes Needed**:
```typescript
// In messageUpdates.ts
export async function fetchMessageUpdates(...) {
  const useAgentAPI = import.meta.env.USE_AGENT_API === 'true';
  
  if (useAgentAPI) {
    // Call agent API directly
    return fetchAgentMessageUpdates(conversationId, opts, abortSignal);
  } else {
    // Use existing backend flow
    const response = await fetch(`${base}/conversation/${conversationId}`, ...);
    return endpointStreamToIterator(response);
  }
}
```

**Pros**: Simple toggle, no model configuration
**Cons**: Bypasses backend, loses database persistence

### Option 3: Backend Proxy to Agent

**Approach**: Add agent API calls in backend `+server.ts`

**Changes Needed**:
1. Detect if model is "bindu_agent"
2. Instead of calling `textGeneration()`, call agent API
3. Convert agent responses to `MessageUpdate` format
4. Stream to frontend as usual

**Pros**: Maintains backend flow, database persistence
**Cons**: More backend changes

## Recommended Integration Approach

**Use Option 1** - Add Bindu Agent as a model using existing `endpointBindu.ts`:

1. **Configure Bindu Endpoint** in `.env`:
   ```bash
   BINDU_BASE_URL=http://localhost:3773
   BINDU_AGENT_NAME="Research Agent"
   ```

2. **Add Bindu to Models** - The endpoint already exists at `lib/server/endpoints/bindu/endpointBindu.ts`

3. **Ensure Authentication** - Agent needs to accept frontend's OAuth token OR disable auth for local dev

4. **Test** - Select "Bindu Agent" model in chat, send message

This approach:
- ✅ Uses existing architecture
- ✅ Maintains database persistence
- ✅ Works with ChatWindow component
- ✅ Supports all features (files, retry, stop, etc.)
- ✅ Minimal code changes

## Current Status

- ✅ Agent API client (`agent-api.ts`) - Working
- ✅ CORS configured - Fixed
- ✅ OAuth token flow - Working
- ✅ Bindu endpoint exists - `endpointBindu.ts`
- ❌ Agent auth blocking requests - Need to disable or fix
- ❌ Bindu endpoint not configured in models list

## Next Steps

1. **Fix Auth Issue** - Disable auth for local agent OR configure agent to accept frontend OAuth tokens
2. **Configure Bindu Model** - Add Bindu agent to models configuration
3. **Test Integration** - Select Bindu model and send message
4. **Verify Streaming** - Ensure responses stream correctly
