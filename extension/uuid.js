let fallbackCounter = 0;

function fallbackBytes() {
    const bytes = new Uint8Array(16);
    let seed = Date.now() + (++fallbackCounter * 0x9e3779b1);
    for (let index = 0; index < bytes.length; index++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        bytes[index] = (seed >>> 24) ^ Math.floor(Math.random() * 256);
    }
    return bytes;
}

export function randomUuid(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();

    const bytes = new Uint8Array(16);
    if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
    else bytes.set(fallbackBytes());

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
