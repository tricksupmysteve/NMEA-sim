/**
 * NMEA 0183 checksums.
 *
 * The checksum is the XOR of every character strictly between the start
 * delimiter (`$` for standard sentences, `!` for encapsulated ones such as
 * AIS) and the `*`, rendered as two upper-case hex digits.
 *
 * Checksums are always computed, never hard-coded — including in the tests,
 * which recompute independently rather than comparing against literals.
 */

export const SENTENCE_TERMINATOR = '\r\n'

const START_DELIMITERS = new Set(['$', '!'])

/**
 * XOR checksum of a sentence body (the part between the delimiter and `*`).
 *
 * A leading `$`/`!` is tolerated and ignored, as is anything from a `*`
 * onwards, so this can be handed either a body or a whole sentence.
 */
export function computeChecksum(body: string): string {
  let start = 0
  const first = body[0]
  if (first !== undefined && START_DELIMITERS.has(first)) start = 1

  let checksum = 0
  for (let index = start; index < body.length; index += 1) {
    const character = body.charCodeAt(index)
    if (character === 0x2a /* '*' */) break
    checksum ^= character
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * Wrap a sentence body into a complete, terminated NMEA 0183 sentence.
 *
 * @param body      Sentence body without the delimiter, `*` or checksum.
 * @param delimiter `$` for standard sentences, `!` for encapsulated ones.
 */
export function formatSentence(body: string, delimiter: '$' | '!' = '$'): string {
  const clean = body.startsWith('$') || body.startsWith('!') ? body.slice(1) : body
  return `${delimiter}${clean}*${computeChecksum(clean)}${SENTENCE_TERMINATOR}`
}

export interface ParsedSentence {
  delimiter: '$' | '!'
  /** Talker + sentence formatter, e.g. `GPRMC`. */
  address: string
  /** Talker identifier, e.g. `GP`. */
  talker: string
  /** Sentence formatter, e.g. `RMC`. */
  formatter: string
  fields: string[]
  checksum: string
  expectedChecksum: string
  valid: boolean
}

/**
 * Parse a sentence for validation purposes. Returns `null` when the input is
 * not a recognisably-shaped sentence at all.
 */
export function parseSentence(sentence: string): ParsedSentence | null {
  const trimmed = sentence.replace(/\r?\n$/, '')
  const delimiter = trimmed[0]
  if (delimiter !== '$' && delimiter !== '!') return null

  const starIndex = trimmed.lastIndexOf('*')
  if (starIndex < 1) return null

  const body = trimmed.slice(1, starIndex)
  const checksum = trimmed.slice(starIndex + 1)
  const parts = body.split(',')
  const address = parts[0] ?? ''
  const expectedChecksum = computeChecksum(body)

  return {
    delimiter,
    address,
    // Proprietary sentences (`P…`) carry a manufacturer code rather than a
    // two-letter talker; treat the whole address as the talker in that case.
    talker: address.startsWith('P') ? address : address.slice(0, 2),
    formatter: address.startsWith('P') ? '' : address.slice(2),
    fields: parts.slice(1),
    checksum: checksum.toUpperCase(),
    expectedChecksum,
    valid: /^[0-9A-Fa-f]{2}$/.test(checksum) && checksum.toUpperCase() === expectedChecksum,
  }
}

/** `true` when the sentence is well-formed and its checksum matches. */
export function verifyChecksum(sentence: string): boolean {
  return parseSentence(sentence)?.valid ?? false
}

/**
 * Produce the same sentence with a deliberately wrong checksum.
 *
 * Used only by fault injection, so a consumer's checksum validation can be
 * exercised. The result is still structurally a sentence — only the checksum
 * is wrong.
 */
export function corruptChecksum(sentence: string): string {
  const parsed = parseSentence(sentence)
  if (!parsed) return sentence
  const correct = parseInt(parsed.expectedChecksum, 16)
  const wrong = ((correct ^ 0x5a) & 0xff).toString(16).toUpperCase().padStart(2, '0')
  return `${parsed.delimiter}${parsed.address}${parsed.fields.length > 0 ? ',' : ''}${parsed.fields.join(',')}*${wrong}${SENTENCE_TERMINATOR}`
}
