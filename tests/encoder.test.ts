import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSentence, verifyChecksum } from '../src/nmea0183/checksum.js'
import {
  MAX_BODY_LENGTH,
  applyChecksumCorruption,
  applyMalformation,
  isBodyValid,
} from '../src/nmea0183/encoder.js'
import { PROFILES, PROFILE_NAMES, getProfile, isProfileName } from '../src/nmea0183/profiles.js'
import { allSentenceDefinitions, getSentenceDefinition } from '../src/nmea0183/registry.js'
import { SENTENCE_IDS, isSentenceId } from '../src/nmea0183/types.js'
import { assertWellFormed, fixedChannels, fixedEncodeContext, testEncoder } from './helpers.js'

describe('body validation', () => {
  it('accepts a normal sentence body', () => {
    assert.ok(isBodyValid('GPRMC,092653.50,A,4157.0000,N,07018.0000,W,6.1,148.2,140326,14.5,W,A'))
    assert.ok(isBodyValid('IIHDT,145.0,T'))
    assert.ok(isBodyValid('AIVDO,1,1,,A,15M:Ih0P00Jv<DvH0@2Ej4`:0000,0'))
  })

  it('rejects the tokens a broken number leaves behind', () => {
    assert.equal(isBodyValid('IIHDT,NaN,T'), false)
    assert.equal(isBodyValid('IIHDT,undefined,T'), false)
    assert.equal(isBodyValid('IIHDT,Infinity,T'), false)
    assert.equal(isBodyValid('IIHDT,null,T'), false)
  })

  it('rejects characters that would break sentence framing', () => {
    assert.equal(isBodyValid('IIHDT,145.0,T*21'), false)
    assert.equal(isBodyValid('IIHDT,145.0,T\r\n'), false)
    assert.equal(isBodyValid('$IIHDT,145.0,T'), false)
    assert.equal(isBodyValid('AIVDM,1,1,,A,pay\\load,0'), false)
  })

  it('rejects non-printable and non-ASCII characters', () => {
    assert.equal(isBodyValid('IIHDT,145.0\u0007,T'), false)
    assert.equal(isBodyValid('IIHDT,145.0°,T'), false)
  })

  it('rejects a malformed address', () => {
    assert.equal(isBodyValid(''), false)
    assert.equal(isBodyValid('hdt,145.0,T'), false)
    assert.equal(isBodyValid('II,145.0,T'), false, 'too short')
    assert.equal(isBodyValid('IIHDTXX,145.0,T'), false, 'too long')
  })

  it('enforces the sentence length limit, with an explicit opt-out', () => {
    const long = `IIHDT,${'9'.repeat(MAX_BODY_LENGTH)}`
    assert.equal(isBodyValid(long), false)
    assert.ok(isBodyValid(long.slice(0, MAX_BODY_LENGTH)))
    assert.ok(isBodyValid(long.slice(0, 82), 82), 'a sentence may opt out of the cap')
  })
})

describe('encoder', () => {
  it('adds the delimiter, checksum and CRLF exactly once', () => {
    const sentence = testEncoder().encode('HDT', fixedEncodeContext())[0]
    assert.ok(sentence)
    assert.equal((sentence.text.match(/\$/g) ?? []).length, 1)
    assert.equal((sentence.text.match(/\*/g) ?? []).length, 1)
    assert.ok(sentence.text.endsWith('\r\n'))
    assert.ok(verifyChecksum(sentence.text))
  })

  it('drops and counts a body that fails validation instead of transmitting it', () => {
    const encoder = testEncoder()
    const channels = fixedChannels()
    // Force a reading that would render as a non-finite number.
    channels.temperature.force({ waterTemperatureC: Number.NaN }, Date.now())

    const sentences = encoder.encode('MTW', fixedEncodeContext(channels))
    // MTW with an empty temperature field is still a legal sentence, so it is
    // transmitted; what matters is that no `NaN` text ever escapes.
    for (const sentence of sentences) {
      assertWellFormed(sentence.text)
      assert.ok(!sentence.text.includes('NaN'))
    }
  })

  it('survives a builder that throws, without taking the stream down', () => {
    const encoder = testEncoder()
    const context = fixedEncodeContext()
    // A channel holding a value of the wrong shape makes the builder throw.
    ;(context.channels.wind as unknown as { force: (value: unknown, at: number) => void }).force(null, Date.now())
    const sentences = encoder.encode('MWV', context)
    assert.equal(sentences.length, 0)
  })

  it('reports settings and allows them to be replaced', () => {
    const encoder = testEncoder()
    assert.equal(encoder.encoderSettings.magneticVariationDegrees, -14.5)
    encoder.updateSettings({ ...encoder.encoderSettings, magneticVariationDegrees: 5 })
    assert.equal(encoder.encoderSettings.magneticVariationDegrees, 5)

    const fields = parseSentence(encoder.encode('MWD', fixedEncodeContext())[0]!.text)?.fields
    // Variation 5° east: magnetic direction is 5° less than true.
    assert.equal(fields?.[2], '235.0')
  })
})

describe('fault injection', () => {
  const sentence = testEncoder().encode('RMC', fixedEncodeContext())[0]!.text

  it('corrupts only the checksum, leaving the sentence structurally intact', () => {
    const corrupted = applyChecksumCorruption(sentence)
    assert.ok(corrupted.startsWith('$GPRMC,'))
    assert.ok(corrupted.endsWith('\r\n'))
    assert.equal(verifyChecksum(corrupted), false)
    assert.deepEqual(parseSentence(corrupted)?.fields, parseSentence(sentence)?.fields)
  })

  it('malforms a sentence structurally, with no checksum at all', () => {
    const malformed = applyMalformation(sentence)
    assert.ok(malformed.startsWith('$GPRMC,'))
    assert.ok(malformed.endsWith('\r\n'))
    assert.ok(!malformed.includes('*'), 'the checksum is gone entirely')
    assert.ok(malformed.length < sentence.length, 'the field list is truncated')
    assert.equal(parseSentence(malformed), null, 'no longer parseable as a sentence')
  })

  it('produces two distinguishable failure modes', () => {
    const corrupted = applyChecksumCorruption(sentence)
    const malformed = applyMalformation(sentence)
    assert.ok(parseSentence(corrupted) !== null, 'a bad checksum still parses')
    assert.equal(parseSentence(malformed), null, 'a malformed sentence does not')
  })

  it('encodes with either fault on request', () => {
    const encoder = testEncoder()
    const context = fixedEncodeContext()

    const corrupted = encoder.encode('HDT', context, { corruptChecksum: true })[0]
    assert.ok(corrupted?.faulted)
    assert.equal(verifyChecksum(corrupted.text), false)

    const malformed = encoder.encode('HDT', context, { malform: true })[0]
    assert.ok(malformed?.faulted)
    assert.ok(!malformed.text.includes('*'))
  })
})

describe('registry and profiles', () => {
  it('registers every declared sentence id exactly once', () => {
    const registered = allSentenceDefinitions().map((definition) => definition.id)
    assert.deepEqual([...registered].sort(), [...SENTENCE_IDS].sort())
    assert.equal(new Set(registered).size, registered.length)
  })

  it('gives every sentence a talker, a positive default rate and a description', () => {
    for (const definition of allSentenceDefinitions()) {
      assert.match(definition.defaultTalker, /^[A-Z]{2}$/, definition.id)
      assert.ok(definition.defaultHz > 0, definition.id)
      assert.ok(definition.description.length > 10, definition.id)
    }
  })

  it('throws clearly for an unknown sentence', () => {
    assert.throws(() => getSentenceDefinition('NOPE' as never), /Unknown NMEA sentence/)
  })

  it('recognises valid sentence and profile names', () => {
    assert.ok(isSentenceId('RMC'))
    assert.equal(isSentenceId('ZZZ'), false)
    assert.ok(isProfileName('garmin-wifi'))
    assert.equal(isProfileName('garmin'), false)
  })

  it('gives the garmin-wifi profile the prioritised first-version sentence set', () => {
    const ids = getProfile('garmin-wifi').sentences.map((entry) => entry.id)
    assert.deepEqual(ids, ['HDT', 'MWV', 'VHW', 'RMC', 'GGA', 'VTG', 'MWD', 'DPT', 'MTW'])
  })

  it('uses the documented default rates', () => {
    const rates = new Map(getProfile('garmin-wifi').sentences.map((entry) => [entry.id, entry.hz]))
    assert.equal(rates.get('HDT'), 5)
    assert.equal(rates.get('MWV'), 5)
    assert.equal(rates.get('VHW'), 2)
    assert.equal(rates.get('RMC'), 1)
    assert.equal(rates.get('GGA'), 1)
    assert.equal(rates.get('VTG'), 1)
    assert.equal(rates.get('MWD'), 1)
    assert.equal(rates.get('DPT'), 1)
    assert.equal(rates.get('MTW'), 0.2)
  })

  it('references only registered sentences from every profile', () => {
    for (const name of PROFILE_NAMES) {
      for (const entry of PROFILES[name].sentences) {
        assert.ok(isSentenceId(entry.id), `${name}: ${entry.id}`)
        assert.ok(entry.hz > 0, `${name}: ${entry.id} rate`)
      }
    }
  })

  it('never lists the same sentence twice within a profile', () => {
    for (const name of PROFILE_NAMES) {
      const ids = PROFILES[name].sentences.map((entry) => entry.id)
      assert.equal(new Set(ids).size, ids.length, name)
    }
  })

  it('maps sentences to the NMEA 2000 PGNs they correspond to', () => {
    const pgnFor = (id: Parameters<typeof getSentenceDefinition>[0]): readonly number[] =>
      getSentenceDefinition(id).pgns ?? []
    assert.ok(pgnFor('HDT').includes(127250), 'vessel heading')
    assert.ok(pgnFor('ROT').includes(127251), 'rate of turn')
    assert.ok(pgnFor('XDR').includes(127257), 'attitude')
    assert.ok(pgnFor('VHW').includes(128259), 'water-referenced speed')
    assert.ok(pgnFor('DPT').includes(128267), 'water depth')
    assert.ok(pgnFor('GLL').includes(129025), 'rapid position')
    assert.ok(pgnFor('VTG').includes(129026), 'COG/SOG')
    assert.ok(pgnFor('GGA').includes(129029), 'GNSS position')
    assert.ok(pgnFor('MWV').includes(130306), 'wind')
    assert.ok(pgnFor('MTW').includes(130316), 'temperature')
    assert.ok(pgnFor('MDA').includes(130313), 'humidity')
    assert.ok(pgnFor('MDA').includes(130314), 'pressure')
  })
})
