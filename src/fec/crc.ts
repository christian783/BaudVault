// Checksums used by the Tape_Framer (design.md, "CRC").
//
// - `crc32`: IEEE 802.3 / zlib variant. Reflected polynomial 0xEDB88320,
//   init 0xFFFFFFFF, final XOR 0xFFFFFFFF. Check value for ASCII "123456789"
//   is 0xCBF43926. Protects the whole Body.
// - `crc16`: CRC-16/CCITT-FALSE. Polynomial 0x1021, init 0xFFFF, no
//   reflection, no final XOR. Check value 0x29B1. Protects Header_Frame bytes 0-13.

const CRC32_TABLE: Uint32Array = new Uint32Array(256)
const CRC16_TABLE: Uint16Array = new Uint16Array(256)

{
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC32_TABLE[n] = c >>> 0

    let h = n << 8
    for (let k = 0; k < 8; k++) h = h & 0x8000 ? ((h << 1) ^ 0x1021) & 0xffff : (h << 1) & 0xffff
    CRC16_TABLE[n] = h
  }
}

/** CRC-32 (IEEE / zlib) of `bytes`, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** CRC-16/CCITT-FALSE of `bytes`, as an unsigned 16-bit integer. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >>> 8) ^ bytes[i]!) & 0xff]!
  }
  return crc
}
