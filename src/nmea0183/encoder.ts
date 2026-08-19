/**
 * The NMEA 0183 encoder.
 *
 * All sentence bodies pass through here on their way to a transport, which is
 * how the simulator can guarantee, structurally, that:
 *
 *  - every sentence starts with `$` (or `!` for encapsulated sentences);
 *  - every sentence carries a freshly computed XOR checksum;
 *  - every sentence ends with CRLF;
 *  - no sentence contains `NaN`, `undefined` or `Infinity`.
 *
 * The last guarantee is enforced, not merely intended: a body that fails
 * validation is dropped and counted rather than transmitted. The only
 * exception is deliberate fault injection, which is applied *after* validation
 * so that a consumer can be tested against broken input on purpose.
 */

import { corruptChecksum, formatSentence } from './checksum.js'
import { getSentenceDefinition } from './registry.js'
import {
  talkerFor,
  type EncodeContext,
  type EncoderSettings,
  type SentenceDefinition,
  type SentenceId,
} from './types.js'

/** Text that must never appear in a sentence body. */
const FORBIDDEN_TOKENS = ['NaN', 'undefined', 'null', 'Infinity']

/** Characters that would break sentence framing if they appeared in a body. */
const FORBIDDEN_CHARACTERS = new Set(['$', '!', '*', '\r', '\n', '\\'])

/** The address field: a two-character talker plus a three-character formatter. */
const ADDRESS_PATTERN = /^[A-Z0-9]{5,6}$/

/**
 * NMEA 0183 limits a sentence to 82 characters including the delimiter, `*`,
 * checksum and CRLF — which leaves 76 for the body.
 */
export const MAX_BODY_LENGTH = 76

export interface EncodedSentence {
  id: SentenceId
  /** Complete sentence including delimiter, checksum and CRLF. */
  text: string
  /** True when fault injection deliberately damaged this sentence. */
  faulted: boolean
}

export interface EncodeOptions {
  /** Deliberately write an incorrect checksum. */
  corruptChecksum?: boolean
  /** Deliberately emit a structurally broken sentence. */
  malform?: boolean
}

export class NmeaEncoder {
  /** Bodies rejected by validation, by sentence id. Should stay at zero. */
  readonly rejected = new Map<SentenceId, number>()

  constructor(private settings: EncoderSettings) {}

  updateSettings(settings: EncoderSettings): void {
    this.settings = settings
  }

  get encoderSettings(): EncoderSettings {
    return this.settings
  }

  /**
   * Encode one sentence id into zero or more complete sentences.
   *
   * Zero is a normal outcome: it means the instrument backing the sentence is
   * disabled, offline or has not produced a reading yet.
   */
  encode(
    id: SentenceId,
    context: Omit<EncodeContext, 'settings'>,
    options: EncodeOptions = {},
  ): EncodedSentence[] {
    const definition = getSentenceDefinition(id)
    const fullContext: EncodeContext = { ...context, settings: this.settings }

    if (!this.instrumentsAvailable(definition, fullContext)) return []

    let bodies: string[]
    try {
      bodies = definition.build(fullContext)
    } catch {
      // A builder must never take the stream down; count it and move on.
      this.countRejection(id)
      return []
    }

    const talker = talkerFor(definition, this.settings)
    const delimiter = definition.delimiter ?? '$'
    const encoded: EncodedSentence[] = []

    for (const body of bodies) {
      const addressed = `${talker}${body}`
      if (!isBodyValid(addressed, definition.maxBodyLength ?? MAX_BODY_LENGTH)) {
        this.countRejection(id)
        continue
      }

      const sentence = formatSentence(addressed, delimiter)

      if (options.malform) {
        encoded.push({ id, text: applyMalformation(sentence), faulted: true })
        continue
      }

      encoded.push(
        options.corruptChecksum
          ? { id, text: applyChecksumCorruption(sentence), faulted: true }
          : { id, text: sentence, faulted: false },
      )
    }

    return encoded
  }

  private instrumentsAvailable(definition: SentenceDefinition, context: EncodeContext): boolean {
    for (const instrument of definition.requires) {
      const channel = context.channels[instrument]
      if (!channel || !channel.available) return false
    }
    return true
  }

  private countRejection(id: SentenceId): void {
    this.rejected.set(id, (this.rejected.get(id) ?? 0) + 1)
  }
}

/**
 * A sentence body is valid when it is printable ASCII, carries a well-formed
 * address, contains no framing characters, and contains none of the tokens a
 * broken number would produce.
 */
export function isBodyValid(body: string, maxLength: number = MAX_BODY_LENGTH): boolean {
  if (body.length === 0 || body.length > maxLength) return false

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string
    if (FORBIDDEN_CHARACTERS.has(character)) return false
    const code = body.charCodeAt(index)
    // Printable ASCII only: anything else cannot be transmitted safely.
    if (code < 0x20 || code > 0x7e) return false
  }

  for (const token of FORBIDDEN_TOKENS) {
    if (body.includes(token)) return false
  }

  const address = body.split(',')[0]
  return address !== undefined && ADDRESS_PATTERN.test(address)
}

/**
 * Rewrite a complete sentence with a deliberately wrong checksum. The sentence
 * stays structurally valid, so only checksum validation should reject it.
 */
export function applyChecksumCorruption(sentence: string): string {
  return corruptChecksum(sentence)
}

/**
 * Produce a deliberately broken sentence: the field list is truncated and the
 * checksum is missing entirely. That is a different failure mode from a merely
 * incorrect checksum, so a consumer's handling of each can be observed
 * separately.
 */
export function applyMalformation(sentence: string): string {
  const trimmed = sentence.replace(/\r?\n$/, '')
  const star = trimmed.lastIndexOf('*')
  const body = star > 0 ? trimmed.slice(0, star) : trimmed
  const truncated = body.slice(0, Math.max(7, Math.floor(body.length * 0.6)))
  return `${truncated}\r\n`
}
