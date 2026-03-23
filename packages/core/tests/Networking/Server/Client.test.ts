import { describe, expect, it } from 'vitest'
import Client from '../../../src/Networking/Server/Client'

describe('client', () => {
  it('generates id when not provided', () => {
    const client = new Client()
    expect(client.id).toBeTruthy()
  })

  it('uses provided id', () => {
    const client = new Client('abc')
    expect(client.id).toBe('abc')
  })
})
