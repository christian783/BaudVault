// Vitest setup file: every network API throws (design.md, Air-Gap Enforcement > Tests).
//
// A test that reaches for the network is a design error, so the call fails
// loudly instead of quietly succeeding or hanging. This file sits outside src/
// because it has to name the forbidden identifiers (Requirement 8.1).
//
// Vitest's default `forks` pool talks to its workers over the child-process IPC
// channel opened at spawn time, not through `net`, `http`, or `dns`, so
// replacing their request entry points here does not disturb the runner.

import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

const NETWORK_BLOCKED_PREFIX = 'Network access is blocked in tests'

/**
 * Returns a stub that throws whether it is called or constructed. A plain
 * `function` (not an arrow) so that `new WebSocket(...)` reaches the throw
 * instead of failing with "is not a constructor".
 */
function blocked(name: string): (...args: unknown[]) => never {
  return function networkBlocked(): never {
    throw new Error(`${NETWORK_BLOCKED_PREFIX}: ${name}`)
  }
}

/** Replaces `target[key]` with a throwing stub, defining it if absent. */
function stub(target: object, key: string, name: string): void {
  Object.defineProperty(target, key, {
    value: blocked(name),
    configurable: true,
    writable: true,
    enumerable: false,
  })
}

// Browser network globals. Defined even where Node lacks them, so a call
// always fails with this message rather than a ReferenceError.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection']) {
  stub(globalThis, name, name)
}
stub(globalThis.navigator, 'sendBeacon', 'navigator.sendBeacon')

// Node request entry points.
stub(http, 'request', 'http.request')
stub(http, 'get', 'http.get')
stub(https, 'request', 'https.request')
stub(https, 'get', 'https.get')
stub(http2, 'connect', 'http2.connect')
stub(net, 'connect', 'net.connect')
stub(net, 'createConnection', 'net.createConnection')
stub(net.Socket.prototype, 'connect', 'net.Socket.connect')
stub(tls, 'connect', 'tls.connect')
stub(dgram, 'createSocket', 'dgram.createSocket')

/** Every lookup, resolve, and reverse function on a dns module or Resolver. */
function stubDns(target: object, label: string): void {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (/^(lookup|resolve|reverse)/.test(key) && typeof Reflect.get(target, key) === 'function') {
      stub(target, key, `${label}.${key}`)
    }
  }
}
stubDns(dns, 'dns')
stubDns(dns.Resolver.prototype, 'dns.Resolver')
stubDns(dns.promises, 'dns.promises')
stubDns(dns.promises.Resolver.prototype, 'dns.promises.Resolver')

// Named ESM imports (`import { request } from 'node:http'`) see the stubs too.
syncBuiltinESMExports()
