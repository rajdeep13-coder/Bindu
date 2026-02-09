<script lang="ts">
	import { contexts, contextId, switchContext, createNewContext, clearContext } from '$lib/stores/chat';
	import type { Context } from '$lib/types/agent';

	function formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const hours = Math.floor(diff / (1000 * 60 * 60));

		if (hours < 24) {
			return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		} else {
			return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		}
	}

	function getContextColor(index: number): string {
		const colors = ['blue', 'green', 'purple', 'orange', 'pink'];
		return colors[index % colors.length];
	}

	function handleSwitchContext(ctxId: string) {
		switchContext(ctxId);
	}

	function handleClearContext(event: Event, ctxId: string) {
		event.stopPropagation();
		if (confirm('Are you sure you want to clear this context? This action cannot be undone.')) {
			clearContext(ctxId);
		}
	}

	$: sortedContexts = [...$contexts].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
	$: activeContextId = $contextId;
</script>

<div class="context-sidebar">
	<div class="sidebar-header">
		<h3>Contexts</h3>
		<button class="new-chat-btn" on:click={createNewContext}>+ New</button>
	</div>
	
	<div class="context-list">
		{#if sortedContexts.length === 0}
			<div class="empty-state">No contexts yet</div>
		{:else}
			{#each sortedContexts as ctx, index (ctx.id)}
				<div 
					class="context-item"
					class:active={ctx.id === activeContextId}
					on:click={() => handleSwitchContext(ctx.id)}
					on:keydown={(e) => e.key === 'Enter' && handleSwitchContext(ctx.id)}
					role="button"
					tabindex="0"
				>
					<div class="context-header">
						<div class="context-badge {getContextColor(index)}">
							{ctx.id.substring(0, 8)}
						</div>
						<div class="context-time">
							{formatTime(ctx.timestamp || Date.now())}
						</div>
						<button 
							class="context-clear-btn"
							on:click={(e) => handleClearContext(e, ctx.id)}
							title="Clear context"
						>
							×
						</button>
					</div>
					<div class="context-preview">
						{ctx.firstMessage || 'New conversation'}
					</div>
					<div class="context-footer">
						<span class="context-tasks">
							{ctx.taskCount || 0} task{(ctx.taskCount || 0) !== 1 ? 's' : ''}
						</span>
						<span class="context-id-label">
							Context: {ctx.id.substring(0, 8)}
						</span>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.context-sidebar {
		width: 300px;
		background-color: #f8f9fa;
		border-right: 1px solid #dee2e6;
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.sidebar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		border-bottom: 1px solid #dee2e6;
	}

	.sidebar-header h3 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
	}

	.new-chat-btn {
		padding: 0.5rem 1rem;
		background-color: #007bff;
		color: white;
		border: none;
		border-radius: 0.375rem;
		cursor: pointer;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.new-chat-btn:hover {
		background-color: #0056b3;
	}

	.context-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.empty-state {
		padding: 2rem 1rem;
		text-align: center;
		color: #6c757d;
		font-style: italic;
	}

	.context-item {
		padding: 1rem;
		margin-bottom: 0.5rem;
		background-color: white;
		border: 1px solid #dee2e6;
		border-radius: 0.375rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.context-item:hover {
		border-color: #007bff;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	}

	.context-item.active {
		background-color: #e7f3ff;
		border-color: #007bff;
	}

	.context-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.context-badge {
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.75rem;
		font-family: 'JetBrains Mono', monospace;
		font-weight: 600;
		color: white;
	}

	.context-badge.blue { background-color: #007bff; }
	.context-badge.green { background-color: #28a745; }
	.context-badge.purple { background-color: #6f42c1; }
	.context-badge.orange { background-color: #fd7e14; }
	.context-badge.pink { background-color: #e83e8c; }

	.context-time {
		font-size: 0.75rem;
		color: #6c757d;
		margin-left: auto;
	}

	.context-clear-btn {
		background: none;
		border: none;
		color: #6c757d;
		cursor: pointer;
		font-size: 1.5rem;
		padding: 0;
		width: 1.5rem;
		height: 1.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
	}

	.context-clear-btn:hover {
		background-color: #dc3545;
		color: white;
	}

	.context-preview {
		font-size: 0.875rem;
		color: #495057;
		margin-bottom: 0.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.context-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.75rem;
		color: #6c757d;
	}

	.context-id-label {
		font-family: 'JetBrains Mono', monospace;
	}
</style>
