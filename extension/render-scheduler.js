function defaultScheduleFrame(callback) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
        return globalThis.requestAnimationFrame(callback);
    }
    return globalThis.setTimeout(callback, 0);
}

export function createRenderScheduler(render, scheduleFrame = defaultScheduleFrame, {
    minInterval = 0,
    now = () => Date.now(),
    scheduleDelay = (callback, delay) => globalThis.setTimeout(callback, delay),
} = {}) {
    let pending = false;
    let latestArgs = [];
    let lastRenderAt = 0;
    let hasRendered = false;

    return (...args) => {
        latestArgs = args;
        if (pending) return;
        pending = true;
        const wait = hasRendered ? Math.max(0, minInterval - (now() - lastRenderAt)) : 0;
        const schedule = wait ? callback => scheduleDelay(callback, wait) : scheduleFrame;
        schedule(() => {
            pending = false;
            const argsToRender = latestArgs;
            latestArgs = [];
            lastRenderAt = now();
            hasRendered = true;
            render(...argsToRender);
        });
    };
}
