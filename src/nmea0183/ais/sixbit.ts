/**
 * AIS six-bit ASCII payload armouring (ITU-R M.1371 / IEC 61162-1).
 *
 * AIS messages are bit fields, transmitted inside NMEA sentences as printable
 * characters. Each character carries six bits: add 48 to the value, and add a
 * further 8 if the result exceeds 87, which skips the unprintable range.
 */

/** Accumulates a bit field, then armours it into six-bit ASCII. */
export class BitWriter {
  private bits: string[] = []

  /** Append `width` bits of an unsigned value, most significant bit first. */
  unsigned(value: number, width: number): this {
    const max = 2 ** width
    let safe = Number.isFinite(value) ? Math.trunc(value) : 0
    safe = ((safe % max) + max) % max
    this.bits.push(safe.toString(2).padStart(width, '0'))
    return this
  }

  /** Append `width` bits of a two's-complement signed value. */
  signed(value: number, width: number): this {
    const max = 2 ** width
    const half = max / 2
    let safe = Number.isFinite(value) ? Math.trunc(value) : 0
    safe = Math.max(-half, Math.min(half - 1, safe))
    return this.unsigned(safe < 0 ? safe + max : safe, width)
  }

  /**
   * Append a string as six-bit AIS characters, padded or truncated to
   * `characters` positions. Unsupported characters become `@` (value 0).
   */
  text(value: string, characters: number): this {
    const padded = value.toUpperCase().padEnd(characters, '@').slice(0, characters)
    for (const character of padded) {
      this.unsigned(sixBitValueOf(character), 6)
    }
    return this
  }

  get length(): number {
    return this.bits.reduce((total, chunk) => total + chunk.length, 0)
  }

  toBitString(): string {
    return this.bits.join('')
  }

  /** Armour the accumulated bits, returning the payload and its fill-bit count. */
  toPayload(): { payload: string; fillBits: number } {
    return encodeSixBit(this.toBitString())
  }
}

/** AIS six-bit character set: `@A…Z[\]^_ !"#…` mapped to values 0-63. */
const SIX_BIT_ALPHABET = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?'

export function sixBitValueOf(character: string): number {
  const index = SIX_BIT_ALPHABET.indexOf(character)
  return index >= 0 ? index : 0
}

/** Armour a bit string into printable six-bit ASCII. */
export function encodeSixBit(bitString: string): { payload: string; fillBits: number } {
  const remainder = bitString.length % 6
  const fillBits = remainder === 0 ? 0 : 6 - remainder
  const padded = bitString.padEnd(bitString.length + fillBits, '0')

  let payload = ''
  for (let index = 0; index < padded.length; index += 6) {
    const value = parseInt(padded.slice(index, index + 6), 2)
    let character = value + 48
    if (character > 87) character += 8
    payload += String.fromCharCode(character)
  }
  return { payload, fillBits }
}

/** Inverse of {@link encodeSixBit}, used by the tests to verify round trips. */
export function decodeSixBit(payload: string, fillBits = 0): string {
  let bits = ''
  for (const character of payload) {
    let value = character.charCodeAt(0) - 48
    if (value > 40) value -= 8
    bits += (value & 0x3f).toString(2).padStart(6, '0')
  }
  return fillBits > 0 ? bits.slice(0, bits.length - fillBits) : bits
}
