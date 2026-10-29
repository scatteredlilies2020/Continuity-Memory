// Wait for meaningful output, not a fixed total duration. Heartbeats alone do
// not keep a stalled request alive; streamed reasoning does count as progress.
export async function requestModel(fetchImpl, url, options, idleMs = 120000, onProgress = () => {}) {
    const controller = new AbortController();
    const parent = options.signal;
    const forwardAbort = () => controller.abort(parent.reason);
    let timer, onAbort;
    const touch = () => {
        clearTimeout(timer);
        if (!controller.signal.aborted) timer = setTimeout(() => controller.abort(
            new Error('Detached API request timed out waiting for progress.')), idleMs);
    };
    if (parent?.aborted) forwardAbort();
    else parent?.addEventListener('abort', forwardAbort, { once: true });
    const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const collect = async () => {
        controller.signal.throwIfAborted();
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        controller.signal.throwIfAborted();
        onProgress({ phase: 'waiting-output', lastProgressAt: Date.now() });
        if (!response.ok || !/text\/event-stream/iu.test(response.headers.get('content-type') || '')) {
            // JSON endpoints cannot report reasoning progress. Preserve the
            // idle guard across headers AND body reads.
            const text = await response.text();
            controller.signal.throwIfAborted();
            let payload;
            try { payload = text ? JSON.parse(text) : {}; }
            catch { payload = { error: text || response.statusText }; }
            return { response, payload };
        }
        let pending = '', output = '', finish = '', done = false, reasoningCharacters = 0;
        const decoder = new TextDecoder();
        const consume = event => {
            const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n').trim();
            if (!data) return;
            if (data === '[DONE]') { done = true; return; }
            const value = JSON.parse(data);
            if (value.error) throw Object.assign(new Error(value.error.message || String(value.error)), { status: value.error.code });
            const choice = value.choices?.[0];
            const delta = choice?.delta;
            const parts = value.candidates?.[0]?.content?.parts || [];
            const text = typeof delta?.content === 'string' ? delta.content
                : Array.isArray(delta?.content) ? delta.content.map(part => part.text || '').join('')
                : typeof choice?.text === 'string' ? choice.text
                : parts.filter(part => !part.thought).map(part => part.text || '').join('');
            const reasoning = delta?.reasoning_content || delta?.reasoning
                || parts.filter(part => part.thought).map(part => part.text || '').join('');
            if (text || reasoning) touch();
            output += text;
            if (choice?.message?.content) { output = choice.message.content; touch(); }
            if (text || reasoning || choice?.message?.content) {
                reasoningCharacters += typeof reasoning === 'string' ? reasoning.length : 0;
                onProgress({ phase: 'receiving', lastProgressAt: Date.now(), outputCharacters: output.length, reasoningCharacters });
            }
            finish = choice?.finish_reason || value.candidates?.[0]?.finishReason || finish;
        };
        for await (const chunk of response.body) {
            controller.signal.throwIfAborted();
            pending += decoder.decode(chunk, { stream: true });
            const events = pending.split(/\r?\n\r?\n/u);
            pending = events.pop() || '';
            for (const event of events) consume(event);
            if (done) break;
        }
        pending += decoder.decode();
        if (pending.trim() && !done) consume(pending);
        controller.signal.throwIfAborted();
        if (!done && !finish) throw new Error('Detached API connection closed before the response completed.');
        return { response, payload: { choices: [{ message: { content: output }, finish_reason: finish || 'stop' }] } };
    };
    touch();
    try { return await Promise.race([collect(), cancelled]); }
    finally {
        clearTimeout(timer);
        parent?.removeEventListener('abort', forwardAbort);
        controller.signal.removeEventListener('abort', onAbort);
    }
}
