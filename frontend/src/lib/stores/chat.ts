import { writable, get } from 'svelte/store';
import type { Task, Context, TaskState } from '$lib/types/agent';
import { isTerminalState, isNonTerminalState, generateUUID } from '$lib/types/agent';
import { agentAPI } from '$lib/services/agent-api';

export interface DisplayMessage {
  id: string;
  text: string;
  role: 'user' | 'assistant' | 'status';
  taskId?: string;
  state?: TaskState;
  timestamp: number;
}

export const currentTaskId = writable<string | null>(null);
export const currentTaskState = writable<TaskState | null>(null);
export const contextId = writable<string | null>(null);
export const replyToTaskId = writable<string | null>(null);
export const messages = writable<DisplayMessage[]>([]);
export const contexts = writable<Context[]>([]);
export const authToken = writable<string | null>(null);
export const isThinking = writable<boolean>(false);
export const error = writable<string | null>(null);

let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function initializeAuth() {
  if (typeof window !== 'undefined') {
    // Use the OAuth token from the settings page
    const token = localStorage.getItem('bindu_oauth_token');
    console.log('=== Initializing Auth ===');
    console.log('Token from localStorage (bindu_oauth_token):', token ? `${token.substring(0, 20)}...` : 'NULL');
    
    if (token) {
      console.log('Setting token in store and API client');
      authToken.set(token);
      agentAPI.setAuthToken(token);
      console.log('Token set successfully');
    } else {
      console.warn('⚠️ No OAuth token found - please authenticate in Settings > Authentication');
    }
  }
}

export function setAuth(token: string | null) {
  console.log('Setting auth token:', token ? `${token.substring(0, 20)}...` : 'null');
  authToken.set(token);
  agentAPI.setAuthToken(token);
  // Also save to the same localStorage key used by settings page
  if (typeof window !== 'undefined') {
    if (token) {
      localStorage.setItem('bindu_oauth_token', token);
    } else {
      localStorage.removeItem('bindu_oauth_token');
    }
  }
}

export function addMessage(text: string, role: 'user' | 'assistant' | 'status', taskId?: string, state?: TaskState) {
  const message: DisplayMessage = {
    id: generateUUID(),
    text,
    role,
    taskId,
    state,
    timestamp: Date.now()
  };
  messages.update(msgs => [...msgs, message]);
}

export function clearMessages() {
  messages.set([]);
}

export function setError(errorMessage: string | null) {
  error.set(errorMessage);
}

export async function loadContexts() {
  try {
    const serverContexts = await agentAPI.listContexts();
    
    const transformedContexts = serverContexts.map(ctx => ({
      id: ctx.context_id || ctx.id,
      context_id: ctx.context_id || ctx.id,
      task_count: ctx.task_count || ctx.taskCount || 0,
      taskCount: ctx.task_count || ctx.taskCount || 0,
      task_ids: ctx.task_ids || ctx.taskIds || [],
      taskIds: ctx.task_ids || ctx.taskIds || [],
      timestamp: Date.now(),
      firstMessage: 'Loading...'
    }));

    for (const ctx of transformedContexts) {
      if (ctx.taskIds && ctx.taskIds.length > 0) {
        try {
          const task = await agentAPI.getTask(ctx.taskIds[0]);
          const history = task.history || [];
          
          for (const msg of history) {
            if (msg.role === 'user') {
              const parts = msg.parts || [];
              const textParts = parts
                .filter(part => part.kind === 'text')
                .map(part => part.text || '');
              if (textParts.length > 0) {
                ctx.firstMessage = textParts[0].substring(0, 50);
                break;
              }
            }
          }
          
          if (task.status && task.status.timestamp) {
            ctx.timestamp = new Date(task.status.timestamp).getTime();
          }
        } catch (err) {
          console.error('Error loading context preview:', err);
        }
      }
    }

    contexts.set(transformedContexts);
  } catch (err) {
    console.error('Error loading contexts:', err);
    setError('Failed to load contexts');
  }
}

export async function switchContext(ctxId: string) {
  try {
    clearMessages();
    contextId.set(ctxId);
    
    const allContexts = get(contexts);
    const selectedContext = allContexts.find(c => c.id === ctxId);
    
    if (!selectedContext || !selectedContext.taskIds || selectedContext.taskIds.length === 0) {
      return;
    }

    const contextTasks: Task[] = [];
    for (const taskId of selectedContext.taskIds) {
      try {
        const task = await agentAPI.getTask(taskId);
        contextTasks.push(task);
      } catch (err) {
        console.error(`Error loading task ${taskId}:`, err);
      }
    }

    contextTasks.sort((a, b) => {
      const timeA = new Date(a.status.timestamp).getTime();
      const timeB = new Date(b.status.timestamp).getTime();
      return timeA - timeB;
    });

    for (const task of contextTasks) {
      const history = task.history || [];
      for (const msg of history) {
        const parts = msg.parts || [];
        const textParts = parts
          .filter(part => part.kind === 'text')
          .map(part => part.text || '');

        if (textParts.length > 0) {
          const text = textParts.join('\n');
          const sender = msg.role === 'user' ? 'user' : 'assistant';
          const state = sender === 'assistant' ? task.status.state : undefined;
          addMessage(text, sender, task.id, state);
        }
      }
    }

    if (contextTasks.length > 0) {
      const lastTask = contextTasks[contextTasks.length - 1];
      currentTaskId.set(lastTask.id);
      currentTaskState.set(lastTask.status.state);
    }
  } catch (err) {
    console.error('Error switching context:', err);
    setError('Failed to load context');
  }
}

export function createNewContext() {
  contextId.set(null);
  currentTaskId.set(null);
  currentTaskState.set(null);
  replyToTaskId.set(null);
  clearMessages();
}

export async function clearContext(ctxId: string) {
  try {
    await agentAPI.clearContext(ctxId);
    
    contexts.update(ctxs => ctxs.filter(c => c.id !== ctxId));
    
    if (get(contextId) === ctxId) {
      createNewContext();
    }
    
    addMessage('Context cleared successfully', 'status');
  } catch (err) {
    console.error('Error clearing context:', err);
    setError('Failed to clear context');
  }
}

export async function sendMessage(text: string) {
  const currentState = get(currentTaskState);
  const currentTask = get(currentTaskId);
  const currentContext = get(contextId);
  const replyTo = get(replyToTaskId);

  let taskId: string;
  const referenceTaskIds: string[] = [];

  if (replyTo) {
    taskId = generateUUID();
    referenceTaskIds.push(replyTo);
  } else if (currentState && isNonTerminalState(currentState) && currentTask) {
    taskId = currentTask;
  } else if (currentTask) {
    taskId = generateUUID();
    referenceTaskIds.push(currentTask);
  } else {
    taskId = generateUUID();
  }

  const messageId = generateUUID();
  const newContextId = currentContext || generateUUID();

  try {
    const params = {
      message: {
        role: 'user' as const,
        parts: [{ kind: 'text' as const, text }],
        kind: 'message' as const,
        messageId,
        contextId: newContextId,
        taskId,
        ...(referenceTaskIds.length > 0 && { referenceTaskIds })
      },
      configuration: {
        acceptedOutputModes: ['application/json']
      }
    };

    const task = await agentAPI.sendMessage(params);
    
    const taskContextId = task.context_id || task.contextId;
    const isNewContext = taskContextId && !currentContext;

    currentTaskId.set(task.id);
    
    if (taskContextId) {
      contextId.set(taskContextId);
    }

    if (isNewContext) {
      await loadContexts();
    }

    const displayMessage = replyTo
      ? `↩️ Replying to task ${replyTo.substring(0, 8)}...\n\n${text}`
      : text;
    
    addMessage(displayMessage, 'user', task.id);
    
    replyToTaskId.set(null);
    isThinking.set(true);
    
    startPollingTask(task.id);
  } catch (err) {
    console.error('Error sending message:', err);
    setError(err instanceof Error ? err.message : 'Failed to send message');
    isThinking.set(false);
  }
}

function startPollingTask(taskId: string) {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  let lastHistoryLength = 0;

  pollingInterval = setInterval(async () => {
    try {
      const task = await agentAPI.getTask(taskId);
      
      const history = task.history || [];
      if (history.length > lastHistoryLength) {
        for (let i = lastHistoryLength; i < history.length; i++) {
          const msg = history[i];
          if (msg.role === 'assistant') {
            const parts = msg.parts || [];
            const textParts = parts
              .filter(part => part.kind === 'text')
              .map(part => part.text || '');
            
            if (textParts.length > 0) {
              const text = textParts.join('\n');
              addMessage(text, 'assistant', task.id, task.status.state);
            }
          }
        }
        lastHistoryLength = history.length;
      }

      currentTaskState.set(task.status.state);

      if (isTerminalState(task.status.state)) {
        isThinking.set(false);
        if (pollingInterval) {
          clearInterval(pollingInterval);
          pollingInterval = null;
        }
      }
    } catch (err) {
      console.error('Error polling task:', err);
      isThinking.set(false);
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
    }
  }, 1000);
}

export function setReplyTo(taskId: string | null) {
  replyToTaskId.set(taskId);
}

export function clearReplyTo() {
  replyToTaskId.set(null);
}
