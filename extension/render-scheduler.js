function defaultScheduleFrame(callback) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
        return globalThis.requestAnimationFrame(callback);
    }
    return globalThis.setTimeout(callback, 0);
}

export function createRenderScheduler(render, scheduleFrame = defaultScheduleFrame) {
    let pending = false;
    let latestArgs = [];

    return (...args) => {
        latestArgs = args;
        if (pending) return;
        pending = true;
        scheduleFrame(() => {
            pending = false;
            const argsToRender = latestArgs;
            latestArgs = [];
            render(...argsToRender);
        });
    };
}
