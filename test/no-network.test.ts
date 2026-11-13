// Tests for test/no-network.setup.ts (Requirement 8.1).
//
// This file sits outside src/, so it may name the forbidden words. The setup
// file is registered through `test.setupFiles`, so it has already run here.

import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { request as namedRequest } from 'node:http'
import { describe, expect, it } from 'vitest'

const BLOCKED = /^Network access is blocked in tests: /

/** Asserts that `run` throws the setup file's error naming `name`. */
function expectBlocked(name: string, run: () => unknown): void {
  expect(run).toThrow(BLOCKED)
  expect(run).toThrow(`: ${name}`)
}

// Indexing through a record keeps the checks independent of which globals
// the Node typings happen to declare.
const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>
const G = globalThis as unknown as Record<string, new (...args: unknown[]) => unknown>

describe('browser network globals', () => {
  it('fetch throws', () => {
    expectBlocked('fetch', () => g.fetch!('http://127.0.0.1/'))
  })

  it.each(['XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection'])(
    '%s throws when constructed',
    (name) => {
      expectBlocked(name, () => new G[name]!('ws://127.0.0.1/'))
    },
  )

  it('navigator.sendBeacon throws', () => {
    const nav = globalThis.navigator as unknown as { sendBeacon: (url: string) => boolean }
    expectBlocked('navigator.sendBeacon', () => nav.sendBeacon('http://127.0.0.1/'))
  })
})

describe('Node request entry points', () => {
  const noop = () => {}

  it('http and https request and get throw', () => {
    expectBlocked('http.request', () => http.request('http://127.0.0.1/'))
    expectBlocked('http.get', () => http.get('http://127.0.0.1/'))
    expectBlocked('https.request', () => https.request('https://127.0.0.1/'))
    expectBlocked('https.get', () => https.get('https://127.0.0.1/'))
    expectBlocked('http2.connect', () => http2.connect('https://127.0.0.1/'))
  })

  it('named ESM imports see the stubs', () => {
    expectBlocked('http.request', () => namedRequest('http://127.0.0.1/'))
  })

  it('net, tls, and dgram connections throw', () => {
    expectBlocked('net.connect', () => net.connect(1, '127.0.0.1'))
    expectBlocked('net.createConnection', () => net.createConnection(1, '127.0.0.1'))
    expectBlocked('net.Socket.connect', () => new net.Socket().connect(1, '127.0.0.1'))
    expectBlocked('tls.connect', () => tls.connect(1, '127.0.0.1'))
    expectBlocked('dgram.createSocket', () => dgram.createSocket('udp4'))
  })

  it('dns lookups throw on the module, promises API, and Resolver classes', () => {
    expectBlocked('dns.lookup', () => dns.lookup('localhost', noop))
    expectBlocked('dns.resolve4', () => dns.resolve4('localhost', noop))
    expectBlocked('dns.reverse', () => dns.reverse('127.0.0.1', noop))
    expectBlocked('dns.promises.lookup', () => dns.promises.lookup('localhost'))
    expectBlocked('dns.Resolver.resolve4', () => new dns.Resolver().resolve4('localhost', noop))
    expectBlocked('dns.promises.Resolver.resolve4', () => new dns.promises.Resolver().resolve4('localhost'))
  })
})
