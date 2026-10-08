import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import './zodConfig'

describe('zodConfig', () => {
  it('disables Zod JIT so the browser never probes new Function() under a strict CSP', () => {
    expect(z.core.globalConfig.jitless).toBe(true)
  })

  it('still validates objects (the non-JIT path)', () => {
    const schema = z.object({ name: z.string().min(1), quantity: z.number().int().positive() })
    expect(schema.safeParse({ name: 'Biriyani', quantity: 3 }).success).toBe(true)
    expect(schema.safeParse({ name: '', quantity: 3 }).success).toBe(false)
  })
})
