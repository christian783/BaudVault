// Byte helpers shared by the pure core. All multi-byte integers are big-endian
// (design.md, "Data Models").
//
// Out-of-range offsets and values throw RangeError: they are programming
// errors, not user input, so they do not use the BaudVaultError classes.

function checkOffset(bytes: Uint8Array, offset: number, size: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length) {
    throw new RangeError('offset out of range')
  }
}

function checkValue(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError('value out of range')
  }
}

/** Reads an unsigned 16-bit big-endian integer at `offset`. */
export function readUint16BE(bytes: Uint8Array, offset: number): number {
  checkOffset(bytes, offset, 2)
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

/** Reads an unsigned 32-bit big-endian integer at `offset`. */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  checkOffset(bytes, offset, 4)
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  )
}

/** Writes `value` (0 to 65,535) as an unsigned 16-bit big-endian integer at `offset`. */
export function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  checkOffset(bytes, offset, 2)
  checkValue(value, 0xffff)
  bytes[offset] = value >>> 8
  bytes[offset + 1] = value & 0xff
}

/** Writes `value` (0 to 4,294,967,295) as an unsigned 32-bit big-endian integer at `offset`. */
export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  checkOffset(bytes, offset, 4)
  checkValue(value, 0xffffffff)
  bytes[offset] = value >>> 24
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

/** Returns a new array holding every part in order. */
export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Overwrites every byte of each array with zero, for secret material that is no longer needed. */
export function zeroize(...arrays: readonly Uint8Array[]): void {
  for (const array of arrays) array.fill(0)
}
