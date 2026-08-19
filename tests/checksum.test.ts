import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SENTENCE_TERMINATOR,
  computeChecksum,
  corruptChecksum,
  formatSentence,
  parseSentence,
  verifyChecksum,
} from '../src/nmea0183/checksum.js'

/**
 * Checksums are recomputed independently here rather than compared against
 * hard-coded literals, so the test proves the algorithm rather than pinning a
 * previously-observed value.
 */
function referenceChecksum(body: string): string {
  let checksum = 0
  for (const character of body) {
    checksum ^= character.charCodeAt(0)
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0')
}

describe('computeChecksum', () => {
  it('XORs every character of the body', () => {
    const body = 'GPRMC,092653.50,A,4157.0000,N,07018.0000,W,6.1,148.2,140326,14.5,W,A'
    assert.equal(computeChecksum(body), referenceChecksum(body))
  })

  it('always returns two upper-case hex digits', () => {
    for (const body of ['A', 'GPGGA,,,,,,,,,,,,,', 'IIHDT,145.0,T', 'WIMWV,67.8,R,15.1,N,A']) {
      const checksum = computeChecksum(body)
      assert.match(checksum, /^[0-9A-F]{2}$/)
      assert.equal(checksum, referenceChecksum(body))
    }
  })

  it('zero-pads a single-digit checksum', () => {
    // 'A' XOR 'C' XOR 'B' = 0x41^0x43^0x42 = 0x40; find a body under 0x10.
    const body = String.fromCharCode(0x41, 0x4a) // 0x41 ^ 0x4a = 0x0b
    assert.equal(computeChecksum(body), '0B')
    assert.equal(computeChecksum(body).length, 2)
  })

  it('ignores a leading $ or ! delimiter', () => {
    const body = 'GPGLL,4157.0000,N,07018.0000,W,092653.50,A,A'
    assert.equal(computeChecksum(`$${body}`), computeChecksum(body))
    assert.equal(computeChecksum(`!${body}`), computeChecksum(body))
  })

  it('stops at the * so a whole sentence can be passed in', () => {
    const body = 'IIHDT,145.0,T'
    assert.equal(computeChecksum(`$${body}*7F`), computeChecksum(body))
  })

  it('handles an empty body', () => {
    assert.equal(computeChecksum(''), '00')
  })
})

describe('formatSentence', () => {
  it('produces $body*XX terminated by CRLF', () => {
    const sentence = formatSentence('IIHDT,145.0,T')
    assert.equal(sentence, `$IIHDT,145.0,T*${computeChecksum('IIHDT,145.0,T')}\r\n`)
    assert.ok(sentence.endsWith(SENTENCE_TERMINATOR))
  })

  it('supports the ! delimiter used by encapsulated sentences', () => {
    const sentence = formatSentence('AIVDM,1,1,,A,177KQJ5000G?tO`K>RA1wUbN0TKH,0', '!')
    assert.ok(sentence.startsWith('!AIVDM,'))
    assert.ok(verifyChecksum(sentence))
  })

  it('does not double up a delimiter that is already present', () => {
    assert.equal(formatSentence('$IIHDT,145.0,T'), formatSentence('IIHDT,145.0,T'))
  })

  it('always terminates with CRLF, never a bare LF', () => {
    const sentence = formatSentence('WIMTW,16.5,C')
    assert.ok(sentence.endsWith('\r\n'))
    assert.equal(sentence.split('\n').length, 2)
    assert.equal((sentence.match(/\r/g) ?? []).length, 1)
  })
})

describe('parseSentence', () => {
  it('splits address, talker, formatter and fields', () => {
    const parsed = parseSentence(formatSentence('GPRMC,092653.50,A,4157.0000,N'))
    assert.ok(parsed)
    assert.equal(parsed.delimiter, '$')
    assert.equal(parsed.address, 'GPRMC')
    assert.equal(parsed.talker, 'GP')
    assert.equal(parsed.formatter, 'RMC')
    assert.deepEqual(parsed.fields, ['092653.50', 'A', '4157.0000', 'N'])
    assert.ok(parsed.valid)
  })

  it('accepts a sentence without a trailing CRLF', () => {
    const parsed = parseSentence('$IIHDT,145.0,T*21')
    assert.ok(parsed)
    assert.equal(parsed.formatter, 'HDT')
  })

  it('rejects input that is not a sentence', () => {
    assert.equal(parseSentence(''), null)
    assert.equal(parseSentence('hello'), null)
    assert.equal(parseSentence('$IIHDT,145.0,T'), null, 'no checksum delimiter')
  })

  it('reports an invalid checksum without throwing', () => {
    const parsed = parseSentence('$IIHDT,145.0,T*00')
    assert.ok(parsed)
    assert.equal(parsed.valid, false)
    assert.notEqual(parsed.checksum, parsed.expectedChecksum)
  })

  it('treats a proprietary address as a whole talker', () => {
    const parsed = parseSentence(formatSentence('PGRME,15.0,M,45.0,M,25.0,M'))
    assert.ok(parsed)
    assert.equal(parsed.talker, 'PGRME')
    assert.equal(parsed.formatter, '')
  })
})

describe('verifyChecksum', () => {
  it('accepts sentences built by formatSentence', () => {
    for (const body of ['GPVTG,148.2,T,162.7,M,6.1,N,11.3,K,A', 'SDDPT,12.0,0.6,', 'WIMWD,240.0,T,254.5,M,14.0,N,7.2,M']) {
      assert.ok(verifyChecksum(formatSentence(body)), body)
    }
  })

  it('rejects a sentence whose payload was altered', () => {
    const sentence = formatSentence('IIVHW,145.0,T,159.5,M,5.80,N,10.74,K')
    const tampered = sentence.replace('5.80', '9.99')
    assert.ok(verifyChecksum(sentence))
    assert.equal(verifyChecksum(tampered), false)
  })

  it('rejects a non-hex checksum', () => {
    assert.equal(verifyChecksum('$IIHDT,145.0,T*ZZ\r\n'), false)
  })
})

describe('corruptChecksum', () => {
  it('keeps the sentence structurally intact but makes the checksum wrong', () => {
    const sentence = formatSentence('GPGGA,092653.50,4157.0000,N,07018.0000,W,1,11,0.8,2.4,M,34.2,M,,')
    const corrupted = corruptChecksum(sentence)

    assert.ok(corrupted.startsWith('$GPGGA,'))
    assert.ok(corrupted.endsWith('\r\n'))
    assert.equal(verifyChecksum(corrupted), false)

    const parsed = parseSentence(corrupted)
    assert.ok(parsed)
    assert.match(parsed.checksum, /^[0-9A-F]{2}$/, 'still two hex digits, just the wrong ones')
    assert.deepEqual(parsed.fields, parseSentence(sentence)?.fields)
  })
})
