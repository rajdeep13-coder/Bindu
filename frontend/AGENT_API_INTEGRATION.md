# Agent API Integration

## Overview

The frontend now has full support for communicating with Bindu agents via the A2A protocol. The agent API client is located in `src/lib/services/agent-api.ts`.

## What Was Fixed

1. **CORS Configuration**: Added CORS middleware to `bindu/server/applications.py` to allow cross-origin requests from the frontend
2. **Middleware Order**: Fixed middleware chain so CORS is first, then auth, ensuring preflight OPTIONS requests are handled correctly
3. **OAuth Token Management**: Ensured OAuth tokens from localStorage are correctly sent in Authorization headers

## Using the Agent API

### Basic Usage

```typescript
import { agentAPI } from '$lib/services/agent-api';

// Set authentication token (usually from OAuth flow)
agentAPI.setAuthToken('your_oauth_token');

// Send a message
const response = await agentAPI.sendMessage('Hello, agent!');

// List contexts
const contexts = await agentAPI.listContexts();

// Get task status
const task = await agentAPI.getTask(taskId);
```

### Streaming Messages

```typescript
import { agentAPI } from '$lib/services/agent-api';

// Stream message responses
for await (const update of agentAPI.sendMessageStream('Tell me about AI', contextId)) {
  if (update.type === 'stream') {
    console.log(update.token); // Partial response
  } else if (update.type === 'finalAnswer') {
    console.log('Done!');
  }
}
```

## Configuration

### Environment Variables

Set in `.env`:

```bash
# Agent API base URL
BINDU_BASE_URL=http://localhost:3773

# Optional: Enable agent API mode for conversations
USE_AGENT_API=false
```

### Agent Deployment

Ensure your agent has CORS configured:

```python
config = {
    "deployment": {
        "url": "http://localhost:3773",
        "expose": True,
        "cors_origins": ["http://localhost:5173"]  # Frontend origin
    },
}
```

## Authentication

The agent API uses OAuth2 Bearer tokens. Tokens are:
1. Obtained via the Settings > Authentication page
2. Stored in `localStorage` under key `bindu_oauth_token`
3. Automatically included in all agent API requests

## Architecture

- **Agent API Client**: `src/lib/services/agent-api.ts` - JSON-RPC 2.0 client
- **Message Updates**: `src/lib/utils/messageUpdates.ts` - Includes `fetchAgentMessageUpdates()` for streaming
- **Chat Store**: `src/lib/stores/chat.ts` - Manages auth state
- **Existing UI**: All existing chat components work as-is

## Testing

The agent API integration is working as shown in the screenshot. The existing chat UI successfully communicates with the agent using the A2A protocol.

## Next Steps

To fully integrate agent API as an option in the conversation flow:

1. Add a model selector that includes "Bindu Agent" as an option
2. Modify `fetchMessageUpdates` to conditionally call `fetchAgentMessageUpdates` based on selected model
3. Add UI to select/switch between contexts

The foundation is complete - the agent API client works, CORS is configured, and authentication flows correctly.
