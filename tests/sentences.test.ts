import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSentence } from '../src/nmea0183/checksum.js'
import { allSentenceDefinitions } from '../src/nmea0183/registry.js'
import { assertWellFormed, encodeOne, fieldsOf, fixedChannels, fixedEncodeContext, testEncoder } from './helpers.js'
import type { SentenceId } from '../src/nmea0183/types.js'

/**
 * Every sentence is checked for three things:
 *
 *  1. the wire-format contract (delimiter, checksum, CRLF, printable ASCII);
 *  2. the field layout the standard specifies;
 *  3. the actual values, against the known fixture readings.
 */

const ALL_IDS = allSentenceDefinitions().map((definition) => definition.id)

describe('every registered sentence', () => {
  it('produces well-formed output from a full instrument set', () => {
    const encoder = testEncoder()
    const context = fixedEncodeContext()
    for (const id of ALL_IDS) {
      const sentences = encoder.encode(id, context)
      assert.ok(sentences.length > 0, `${id} produced nothing`)
      for (const sentence of sentences) {
        assertWellFormed(sentence.text)
        assert.equal(sentence.faulted, false)
      }
    }
    assert.equal(encoder.rejected.size, 0, 'no sentence should be rejected by validation')
  })

  it('produces nothing at all when its instrument is offline', () => {
    const encoder = testEncoder()
    for (const definition of allSentenceDefinitions()) {
      if (definition.requires.length === 0) continue
      const channels = fixedChannels()
      for (const instrument of definition.requires) {
        channels[instrument].fault = 'offline'
      }
      const sentences = encoder.encode(definition.id, fixedEncodeContext(channels))
      assert.equal(sentences.length, 0, `${definition.id} still emitted with ${definition.requires.join('/')} offline`)
    }
  })

  it('produces nothing when its instrument is disabled', () => {
    const encoder = testEncoder()
    for (const definition of allSentenceDefinitions()) {
      if (definition.requires.length === 0) continue
      const channels = fixedChannels()
      for (const instrument of definition.requires) {
        channels[instrument].enabled = false
      }
      assert.equal(encoder.encode(definition.id, fixedEncodeContext(channels)).length, 0, definition.id)
    }
  })

  it('uses the talker the profile asked for', () => {
    const encoder = testEncoder()
    const context = fixedEncodeContext()
    const expected: Partial<Record<SentenceId, string>> = {
      RMC: 'GP',
      GGA: 'GP',
      VTG: 'GP',
      HDT: 'II',
      VHW: 'II',
      MWV: 'WI',
      MWD: 'WI',
      DPT: 'SD',
      MTW: 'WI',
      XDR: 'YX',
      VDO: 'AI',
    }
    for (const [id, talker] of Object.entries(expected) as Array<[SentenceId, string]>) {
      const first = encoder.encode(id, context)[0]
      assert.ok(first)
      assert.equal(parseSentence(first.text)?.talker, talker, id)
    }
  })
})

describe('RMC', () => {
  const sentence = encodeOne('RMC')

  it('is well formed and addressed $GPRMC', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$GPRMC,'))
  })

  it('carries UTC, status, position, SOG, COG, date and variation', () => {
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '092653.50', 'UTC')
    assert.equal(fields[1], 'A', 'status: data valid')
    assert.equal(fields[2], '4157.0000')
    assert.equal(fields[3], 'N')
    assert.equal(fields[4], '07018.0000')
    assert.equal(fields[5], 'W')
    assert.equal(fields[6], '6.1', 'SOG in knots')
    assert.equal(fields[7], '148.2', 'COG true')
    assert.equal(fields[8], '140326', 'date ddmmyy')
    assert.equal(fields[9], '14.5', 'magnetic variation magnitude')
    assert.equal(fields[10], 'W', 'variation hemisphere')
    assert.equal(fields[11], 'A', 'mode indicator: autonomous')
  })

  it('reports status V and empty position when the fix is invalid', () => {
    const channels = fixedChannels()
    channels.gps.fault = 'invalid'
    // The sampler would normally set fixQuality 0; force it directly here.
    const sample = channels.gps.value
    assert.ok(sample)
    channels.gps.force({ ...sample, fixQuality: 0 }, Date.now())

    const invalid = encodeOne('RMC', channels)
    assertWellFormed(invalid)
    const fields = fieldsOf(invalid)
    assert.equal(fields[1], 'V', 'navigation receiver warning')
    assert.equal(fields[2], '', 'latitude omitted')
    assert.equal(fields[4], '', 'longitude omitted')
    assert.equal(fields[6], '', 'SOG omitted')
    assert.equal(fields[11], 'N', 'mode indicator: not valid')
    assert.equal(fields[8], '140326', 'the date is still reported')
  })
})

describe('GGA', () => {
  const sentence = encodeOne('GGA')

  it('is well formed and addressed $GPGGA', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$GPGGA,'))
  })

  it('carries UTC, position, fix quality, satellites, HDOP and altitude', () => {
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '092653.50')
    assert.equal(fields[1], '4157.0000')
    assert.equal(fields[2], 'N')
    assert.equal(fields[3], '07018.0000')
    assert.equal(fields[4], 'W')
    assert.equal(fields[5], '1', 'GPS fix')
    assert.equal(fields[6], '11', 'satellites used, zero-padded to two digits')
    assert.equal(fields[7], '0.8', 'HDOP')
    assert.equal(fields[8], '2.4', 'antenna altitude')
    assert.equal(fields[9], 'M')
    assert.equal(fields[10], '34.2', 'geoid separation')
    assert.equal(fields[11], 'M')
  })

  it('reports fix quality 0 and no satellites when the fix is invalid', () => {
    const channels = fixedChannels()
    channels.gps.fault = 'invalid'
    const sample = channels.gps.value
    assert.ok(sample)
    channels.gps.force({ ...sample, fixQuality: 0 }, Date.now())

    const fields = fieldsOf(encodeOne('GGA', channels))
    assert.equal(fields[5], '0')
    assert.equal(fields[6], '00')
    assert.equal(fields[1], '')
  })
})

describe('VTG', () => {
  const sentence = encodeOne('VTG')

  it('is well formed and addressed $GPVTG', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$GPVTG,'))
  })

  it('carries course over ground and ground speed in both units', () => {
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '148.2', 'COG true')
    assert.equal(fields[1], 'T')
    // Variation is 14.5° west, so magnetic course is 14.5° greater than true.
    assert.equal(fields[2], '162.7', 'COG magnetic')
    assert.equal(fields[3], 'M')
    assert.equal(fields[4], '6.1', 'SOG in knots')
    assert.equal(fields[5], 'N')
    assert.equal(fields[6], '11.3', 'SOG in km/h')
    assert.equal(fields[7], 'K')
    assert.equal(fields[8], 'A', 'mode indicator')
  })
})

describe('HDT', () => {
  const sentence = encodeOne('HDT')

  it('is well formed and addressed $IIHDT', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$IIHDT,'))
  })

  it('carries the true heading', () => {
    assert.deepEqual(fieldsOf(sentence), ['145.0', 'T'])
  })

  it('keeps transmitting a frozen heading, unchanged', () => {
    const channels = fixedChannels()
    const original = channels.heading.value
    assert.ok(original)
    channels.heading.fault = 'frozen'
    // A frozen channel refuses new readings and keeps serving the old one.
    channels.heading.update({ ...original, headingTrue: 200 }, Date.now())
    assert.deepEqual(fieldsOf(encodeOne('HDT', channels)), ['145.0', 'T'])
  })
})

describe('HDG and HDM', () => {
  it('HDG carries sensor heading, deviation and variation', () => {
    const sentence = encodeOne('HDG')
    assertWellFormed(sentence)
    const fields = fieldsOf(sentence)
    // Magnetic heading 159.5 less 0.5 of deviation gives the sensor reading.
    assert.equal(fields[0], '159.0')
    assert.equal(fields[1], '0.5')
    assert.equal(fields[2], 'E', 'deviation east')
    assert.equal(fields[3], '14.5')
    assert.equal(fields[4], 'W', 'variation west')
  })

  it('HDM carries the magnetic heading', () => {
    const sentence = encodeOne('HDM')
    assertWellFormed(sentence)
    assert.deepEqual(fieldsOf(sentence), ['159.5', 'M'])
  })

  it('HDG and HDT describe the same heading in different references', () => {
    const trueHeading = Number(fieldsOf(encodeOne('HDT'))[0])
    const magnetic = Number(fieldsOf(encodeOne('HDM'))[0])
    // Variation 14.5° west: magnetic = true + 14.5.
    assert.ok(Math.abs(magnetic - (trueHeading + 14.5)) < 0.05)
  })
})

describe('VHW', () => {
  const sentence = encodeOne('VHW')

  it('is well formed and addressed $IIVHW', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$IIVHW,'))
  })

  it('carries heading and speed through the water', () => {
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '145.0')
    assert.equal(fields[1], 'T')
    assert.equal(fields[2], '159.5')
    assert.equal(fields[3], 'M')
    assert.equal(fields[4], '5.80', 'speed through the water, knots')
    assert.equal(fields[5], 'N')
    assert.equal(fields[6], '10.74', 'speed through the water, km/h')
    assert.equal(fields[7], 'K')
  })

  it('reports speed through the water, not speed over ground', () => {
    // The fixture has SOG 6.1 and STW 5.8; VHW must carry the latter.
    assert.equal(fieldsOf(sentence)[4], '5.80')
    assert.notEqual(fieldsOf(sentence)[4], '6.10')
  })

  it('omits the heading fields but keeps the speed when the compass is offline', () => {
    const channels = fixedChannels()
    channels.heading.fault = 'offline'
    const withoutHeading = encodeOne('VHW', channels)
    assertWellFormed(withoutHeading)
    const fields = fieldsOf(withoutHeading)
    assert.equal(fields[0], '')
    assert.equal(fields[1], 'T', 'the unit field is still present')
    assert.equal(fields[4], '5.80')
  })
})

describe('MWV', () => {
  it('carries the apparent wind with reference R', () => {
    const sentence = encodeOne('MWV')
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$WIMWV,'))
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '67.8', 'apparent wind angle off the bow')
    assert.equal(fields[1], 'R', 'relative/apparent reference')
    assert.equal(fields[2], '15.1', 'apparent wind speed')
    assert.equal(fields[3], 'N', 'knots')
    assert.equal(fields[4], 'A', 'valid')
  })

  it('carries the true wind angle with reference T', () => {
    const sentence = encodeOne('MWVT')
    assertWellFormed(sentence)
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '95.0', 'true wind angle off the bow')
    assert.equal(fields[1], 'T')
    assert.equal(fields[2], '14.0', 'true wind speed')
    assert.equal(fields[4], 'A')
  })

  it('keeps apparent and true as genuinely different measurements', () => {
    const apparent = fieldsOf(encodeOne('MWV'))
    const trueWind = fieldsOf(encodeOne('MWVT'))
    assert.notEqual(apparent[0], trueWind[0], 'angles differ')
    assert.notEqual(apparent[2], trueWind[2], 'speeds differ')
    assert.notEqual(apparent[1], trueWind[1], 'references differ')
  })

  it('flags the reading invalid with status V rather than going silent', () => {
    const channels = fixedChannels()
    channels.wind.fault = 'invalid'
    const sentence = encodeOne('MWV', channels)
    assertWellFormed(sentence)
    assert.equal(fieldsOf(sentence)[4], 'V')
  })
})

describe('MWD', () => {
  const sentence = encodeOne('MWD')

  it('is well formed and addressed $WIMWD', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$WIMWD,'))
  })

  it('carries the true wind direction in both references and speed in both units', () => {
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '240.0', 'true wind direction, true')
    assert.equal(fields[1], 'T')
    assert.equal(fields[2], '254.5', 'true wind direction, magnetic')
    assert.equal(fields[3], 'M')
    assert.equal(fields[4], '14.0', 'true wind speed, knots')
    assert.equal(fields[5], 'N')
    assert.equal(fields[6], '7.2', 'true wind speed, m/s')
    assert.equal(fields[7], 'M')
  })

  it('reports a compass direction, not an angle off the bow', () => {
    // MWD says 240 (compass); MWV/T says 95 (relative to a 145° heading).
    assert.equal(fieldsOf(sentence)[0], '240.0')
    assert.equal(fieldsOf(encodeOne('MWVT'))[0], '95.0')
  })
})

describe('DPT and DBT', () => {
  it('DPT carries depth below the transducer and the transducer offset', () => {
    const sentence = encodeOne('DPT')
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$SDDPT,'))
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '12.0', 'depth below the transducer')
    assert.equal(fields[1], '0.6', 'transducer offset below the waterline')
    assert.equal(fields[2], '', 'maximum range scale not in use')
  })

  it('DBT carries the same depth in feet, metres and fathoms', () => {
    const sentence = encodeOne('DBT')
    assertWellFormed(sentence)
    const fields = fieldsOf(sentence)
    assert.equal(fields[1], 'f')
    assert.equal(fields[2], '12.0')
    assert.equal(fields[3], 'M')
    assert.equal(fields[5], 'F')
    assert.ok(Math.abs(Number(fields[0]) - 39.4) < 0.1, 'feet')
    assert.ok(Math.abs(Number(fields[4]) - 6.6) < 0.1, 'fathoms')
  })

  it('DPT plus the offset gives the depth below the surface', () => {
    const fields = fieldsOf(encodeOne('DPT'))
    assert.ok(Math.abs(Number(fields[0]) + Number(fields[1]) - 12.6) < 0.05)
  })
})

describe('MTW', () => {
  const sentence = encodeOne('MTW')

  it('is well formed and carries the water temperature in Celsius', () => {
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('$WIMTW,'))
    assert.deepEqual(fieldsOf(sentence), ['16.5', 'C'])
  })

  it('handles a sub-zero temperature without breaking the format', () => {
    const channels = fixedChannels()
    channels.temperature.force({ waterTemperatureC: -1.4 }, Date.now())
    const cold = encodeOne('MTW', channels)
    assertWellFormed(cold)
    assert.deepEqual(fieldsOf(cold), ['-1.4', 'C'])
  })
})

describe('optional sentences', () => {
  it('GLL carries position, UTC and status', () => {
    const fields = fieldsOf(encodeOne('GLL'))
    assert.equal(fields[0], '4157.0000')
    assert.equal(fields[4], '092653.50')
    assert.equal(fields[5], 'A')
  })

  it('ZDA carries UTC time and a four-digit year', () => {
    const fields = fieldsOf(encodeOne('ZDA'))
    assert.deepEqual(fields, ['092653.50', '14', '03', '2026', '00', '00'])
  })

  it('GSA carries a twelve-wide satellite block plus DOP figures', () => {
    const fields = fieldsOf(encodeOne('GSA'))
    assert.equal(fields[0], 'A')
    assert.equal(fields[1], '3', '3D fix')
    assert.equal(fields.length, 17, 'mode, fix type, 12 satellites, PDOP, HDOP, VDOP')
    assert.equal(fields[2], '03')
    assert.equal(fields[6], '24')
    assert.equal(fields[7], '', 'unused satellite slots stay empty')
    assert.equal(fields[14], '1.6', 'PDOP')
    assert.equal(fields[15], '0.8', 'HDOP')
    assert.equal(fields[16], '1.3', 'VDOP')
  })

  it('GSV splits the satellites in view four per sentence', () => {
    const sentences = testEncoder().encode('GSV', fixedEncodeContext())
    assert.equal(sentences.length, 2, 'five satellites need two sentences')
    for (const sentence of sentences) assertWellFormed(sentence.text)

    const first = fieldsOf(sentences[0]!.text)
    assert.equal(first[0], '2', 'total sentences')
    assert.equal(first[1], '1', 'sentence number')
    assert.equal(first[2], '05', 'satellites in view')
    assert.equal(first[3], '03', 'first PRN')
    assert.equal(first[5], '123', 'azimuth is three digits')

    const second = fieldsOf(sentences[1]!.text)
    assert.equal(second[1], '2')
    assert.equal(second.length, 3 + 4, 'the last sentence carries only the remaining satellite')
  })

  it('ROT carries the rate of turn with a validity flag', () => {
    assert.deepEqual(fieldsOf(encodeOne('ROT')), ['12.4', 'A'])
  })

  it('VLW carries total and trip distance through the water', () => {
    assert.deepEqual(fieldsOf(encodeOne('VLW')), ['1234.50', 'N', '12.30', 'N'])
  })

  it('XDR carries heel, pitch and the barometer', () => {
    const sentences = testEncoder().encode('XDR', fixedEncodeContext())
    assert.ok(sentences.length >= 1)
    for (const sentence of sentences) assertWellFormed(sentence.text)

    const combined = sentences.map((sentence) => sentence.text).join('')
    assert.ok(combined.includes('A,-8.4,D,ROLL'), 'heel to port is negative')
    assert.ok(combined.includes('A,1.2,D,PTCH'))
    assert.ok(combined.includes('P,1.01400,B,Barometer'))
    assert.ok(combined.includes('C,16.5,C,WaterTemp'))
  })

  it('MDA carries pressure, temperatures, humidity and wind', () => {
    const sentence = encodeOne('MDA')
    assertWellFormed(sentence)
    const fields = fieldsOf(sentence)
    assert.equal(fields[1], 'I', 'inches of mercury')
    assert.equal(fields[3], 'B', 'bars')
    assert.ok(Math.abs(Number(fields[0]) - 29.944) < 0.01)
    assert.ok(Math.abs(Number(fields[2]) - 1.014) < 0.001)
    assert.equal(fields[4], '19.0', 'air temperature')
    assert.equal(fields[6], '16.5', 'water temperature')
    assert.equal(fields[8], '68.0', 'relative humidity')
    assert.equal(fields[12], '240.0', 'true wind direction')
    assert.equal(fields[16], '14.0', 'true wind speed in knots')
  })
})

describe('AIS sentences', () => {
  it('VDO reports own ship as an encapsulated sentence', () => {
    const sentence = encodeOne('VDO')
    assertWellFormed(sentence)
    assert.ok(sentence.startsWith('!AIVDO,'), 'uses the ! delimiter')
    const fields = fieldsOf(sentence)
    assert.equal(fields[0], '1', 'total parts')
    assert.equal(fields[1], '1', 'part number')
    assert.equal(fields[3], 'A', 'radio channel')
    assert.ok((fields[4] ?? '').length > 20, 'payload present')
    assert.equal(fields[5], '0', 'no fill bits in a 168-bit message')
  })

  it('VDM reports one sentence per target', () => {
    const sentences = testEncoder().encode('VDM', fixedEncodeContext())
    assert.equal(sentences.length, 1, 'the fixture has one target')
    assertWellFormed(sentences[0]!.text)
    assert.ok(sentences[0]!.text.startsWith('!AIVDM,'))
  })

  it('produces nothing when AIS is disabled', () => {
    const channels = fixedChannels()
    channels.ais.enabled = false
    assert.equal(testEncoder().encode('VDO', fixedEncodeContext(channels)).length, 0)
    assert.equal(testEncoder().encode('VDM', fixedEncodeContext(channels)).length, 0)
  })
})
