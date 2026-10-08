import { z } from 'zod'

/**
 * Turns off Zod's JIT compiler for the browser bundle. Without this, Zod probes
 * `new Function('')` at start-up (swallowing the error); under a strict Content Security Policy
 * the browser still reports that probe as an `unsafe-eval` violation. Skipping the probe lets the
 * CSP stay free of `'unsafe-eval'` (checkpoint 4.7) and costs nothing measurable for our small forms.
 *
 * It must run before any schema is constructed, so `main.tsx` imports this module FIRST.
 */
z.config({ jitless: true })
