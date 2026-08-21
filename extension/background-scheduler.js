// Coalesce message bursts and keep background work out of overlapping model/storage requests.
export function createBackgroundScheduler(run, {
    delay = 250,
    schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout,
} = {}) {
    let timer = null;
    let running = false;
    let pending = false;

    const arm = wait => {
        if (timer !== null) cancel(timer);
        timer = schedule(async () => {
            timer = null;
            if (running) {
                pending = true;
                return;
            }
            running = true;
            try {
                await run();
            } finally {
                running = false;
                if (pending) {
                    pending = false;
                    arm(delay);
                }
            }
        }, Math.max(0, wait));
    };

    return {
        schedule(wait = delay) {
            if (running) {
                pending = true;
                return;
            }
            arm(wait);
        },
        cancel() {
            if (timer !== null) cancel(timer);
            timer = null;
            pending = false;
        },
        get running() { return running; },
        get pending() { return pending; },
    };
}
