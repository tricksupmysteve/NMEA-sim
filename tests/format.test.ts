import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EMPTY_FIELD,
  formatDegrees,
  formatInteger,
  formatLatitude,
  formatLongitude,
  formatNonNegative,
  formatNumber,
  formatUtcDate,
  formatUtcTime,
  formatVariation,
  isValidDate,
  joinFields,
} from '../src/nmea0183/format.js'

/** Values that must never reach the wire as text. */
const HOSTILE_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null] as const

describe('formatLatitude', () => {
  it('renders ddmm.mmmm with a hemisphere', () => {
    assert.deepEqual(formatLatitude(41.95), { value: '4157.0000', hemisphere: 'N' })
  })

  it('uses S for the southern hemisphere and never a minus sign', () => {
    const south = formatLatitude(-33.8688)
    assert.equal(south.hemisphere, 'S')
    assert.ok(!south.value.includes('-'))
    assert.equal(south.value, '3352.1280')
  })

  it('zero-pads degrees to two digits and minutes to two integer digits', () => {
    assert.equal(formatLatitude(1.05).value, '0103.0000')
    assert.equal(formatLatitude(0.001).value, '0000.0600')
  })

  it('carries into the degrees when minutes round up to 60', () => {
    // 41.99999999 degrees is 41° 59.99999...' — rounding must not print 59.99'
    // as 60.0000'.
    const result = formatLatitude(41.999999999)
    assert.equal(result.value, '4200.0000')
  })

  it('clamps beyond the poles rather than emitting an impossible value', () => {
    assert.equal(formatLatitude(95).value, '9000.0000')
    assert.equal(formatLatitude(-95).hemisphere, 'S')
  })

  it('returns empty fields for values that cannot be rendered', () => {
    for (const value of HOSTILE_NUMBERS) {
      const result = formatLatitude(value)
      assert.equal(result.value, EMPTY_FIELD)
      assert.equal(result.hemisphere, EMPTY_FIELD)
    }
  })

  it('always matches the ddmm.mmmm shape', () => {
    for (let latitude = -89.9; latitude <= 89.9; latitude += 3.7) {
      assert.match(formatLatitude(latitude).value, /^\d{2}\d{2}\.\d{4}$/, `latitude ${latitude}`)
    }
  })
})

describe('formatLongitude', () => {
  it('renders dddmm.mmmm with a hemisphere', () => {
    assert.deepEqual(formatLongitude(-70.3), { value: '07018.0000', hemisphere: 'W' })
  })

  it('zero-pads degrees to three digits', () => {
    assert.equal(formatLongitude(9.5).value, '00930.0000')
    assert.equal(formatLongitude(151.2093).value, '15112.5580')
  })

  it('uses E for positive longitudes', () => {
    assert.equal(formatLongitude(151.2093).hemisphere, 'E')
  })

  it('wraps rather than clamping across the antimeridian', () => {
    assert.equal(formatLongitude(181).hemisphere, 'W')
    assert.equal(formatLongitude(181).value, '17900.0000')
    assert.equal(formatLongitude(-181).hemisphere, 'E')
  })

  it('never renders -0', () => {
    const result = formatLongitude(-0)
    assert.equal(result.hemisphere, 'E')
    assert.equal(result.value, '00000.0000')
  })

  it('returns empty fields for values that cannot be rendered', () => {
    for (const value of HOSTILE_NUMBERS) {
      assert.equal(formatLongitude(value).value, EMPTY_FIELD)
    }
  })

  it('always matches the dddmm.mmmm shape', () => {
    for (let longitude = -179.5; longitude <= 179.5; longitude += 7.3) {
      assert.match(formatLongitude(longitude).value, /^\d{3}\d{2}\.\d{4}$/, `longitude ${longitude}`)
    }
  })
})

describe('formatUtcTime', () => {
  it('renders hhmmss.ss', () => {
    assert.equal(formatUtcTime(new Date('2026-03-14T09:26:53.500Z')), '092653.50')
  })

  it('zero-pads every component', () => {
    assert.equal(formatUtcTime(new Date('2026-01-02T03:04:05.060Z')), '030405.06')
  })

  it('supports whole-second output', () => {
    assert.equal(formatUtcTime(new Date('2026-03-14T09:26:53.500Z'), 0), '092653')
  })

  it('uses UTC regardless of the host time zone', () => {
    assert.equal(formatUtcTime(new Date('2026-06-30T23:59:59.990Z'), 2), '235959.99')
  })

  it('returns an empty field for an invalid date', () => {
    assert.equal(formatUtcTime(new Date('nonsense')), EMPTY_FIELD)
  })
})

describe('formatUtcDate', () => {
  it('renders ddmmyy', () => {
    assert.equal(formatUtcDate(new Date('2026-03-14T09:26:53Z')), '140326')
  })

  it('zero-pads and wraps the year to two digits', () => {
    assert.equal(formatUtcDate(new Date('2005-01-02T00:00:00Z')), '020105')
    assert.equal(formatUtcDate(new Date('2000-12-31T00:00:00Z')), '311200')
  })

  it('returns an empty field for an invalid date', () => {
    assert.equal(formatUtcDate(new Date(Number.NaN)), EMPTY_FIELD)
  })
})

describe('numeric formatters', () => {
  it('never emit NaN, Infinity or undefined', () => {
    for (const value of HOSTILE_NUMBERS) {
      assert.equal(formatNumber(value, 1), EMPTY_FIELD)
      assert.equal(formatNonNegative(value, 1), EMPTY_FIELD)
      assert.equal(formatInteger(value), EMPTY_FIELD)
      assert.equal(formatDegrees(value), EMPTY_FIELD)
    }
  })

  it('renders a fixed number of decimals', () => {
    assert.equal(formatNumber(6.1, 1), '6.1')
    assert.equal(formatNumber(6, 2), '6.00')
    assert.equal(formatNumber(-8.44, 1), '-8.4')
  })

  it('normalises negative zero', () => {
    assert.equal(formatNumber(-0, 1), '0.0')
    assert.equal(formatNumber(-0.001, 1), '0.0')
  })

  it('clamps negatives to zero where a negative would be meaningless', () => {
    assert.equal(formatNonNegative(-3.2, 1), '0.0')
    assert.equal(formatNonNegative(4.25, 1), '4.3')
  })

  it('zero-pads integers to a requested width', () => {
    assert.equal(formatInteger(7, 2), '07')
    assert.equal(formatInteger(2026, 4), '2026')
    assert.equal(formatInteger(11), '11')
  })

  it('wraps angles into [0, 360) after rounding', () => {
    assert.equal(formatDegrees(359.97, 1), '0.0', 'must not print 360.0')
    assert.equal(formatDegrees(360, 1), '0.0')
    assert.equal(formatDegrees(-1, 1), '359.0')
    assert.equal(formatDegrees(722.5, 1), '2.5')
  })
})

describe('formatVariation', () => {
  it('splits a signed variation into a magnitude and a hemisphere', () => {
    assert.deepEqual(formatVariation(-14.5), { value: '14.5', direction: 'W' })
    assert.deepEqual(formatVariation(3.2), { value: '3.2', direction: 'E' })
  })

  it('never emits a negative magnitude', () => {
    assert.ok(!formatVariation(-20).value.includes('-'))
  })

  it('returns empty fields when there is no variation to report', () => {
    assert.deepEqual(formatVariation(undefined), { value: EMPTY_FIELD, direction: EMPTY_FIELD })
  })
})

describe('joinFields', () => {
  it('renders null and undefined as empty fields', () => {
    assert.equal(joinFields('IIVHW', ['145.0', 'T', null, 'M', undefined, 'N']), 'IIVHW,145.0,T,,M,,N')
  })

  it('formats bare numbers to one decimal place', () => {
    assert.equal(joinFields('WIMTW', [16.53, 'C']), 'WIMTW,16.5,C')
  })
})

describe('isValidDate', () => {
  it('accepts real dates and rejects everything else', () => {
    assert.ok(isValidDate(new Date('2026-03-14T00:00:00Z')))
    assert.equal(isValidDate(new Date('nonsense')), false)
    assert.equal(isValidDate(null), false)
    assert.equal(isValidDate(undefined), false)
  })
})
