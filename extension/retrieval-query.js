export function recentRetrievalQuery(messages, messageLimit = 6) {
    const limit = Math.min(50, Math.max(2, Number(messageLimit) || 6));
    return (messages || [])
        .slice(-limit)
        .map(message => `${message.name || ''}: ${message.mes || ''}`)
        .join('\n');
}
