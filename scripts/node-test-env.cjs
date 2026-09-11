// Browser storage uses Web Crypto. Node 18 does not expose it globally in all
// execution modes; supply the native implementation to each test worker.
globalThis.crypto ??= require('node:crypto').webcrypto;
