import process from 'process';
import { Buffer } from 'buffer';

// Provide Node-like globals early for browserified deps (streams, cipher, etc.)
if (!globalThis.process) globalThis.process = process || { env: {}, browser: true, nextTick: (cb, ...args) => setTimeout(cb, 0, ...args) };
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.global) globalThis.global = globalThis;
