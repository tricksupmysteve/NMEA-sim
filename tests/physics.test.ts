import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addVectors,
  angleDifference,
  approachAngle,
  blendAngles,
  clamp,
  lerp,
  normalizeDegrees180,
  normalizeDegrees360,
  polarToVector,
  roundTo,
  smoothingAlpha,
  subtractVectors,
  vectorToPolar,
} from '../src/core/math.js'
import {
  knotsToKilometresPerHour,
  knotsToMetresPerSecond,
  metresPerSecondToKnots,
  metresToFathoms,
  metresToFeet,
  dewPointCelsius,
} from '../src/core/units.js'
import {
  advancePosition,
  apparentWind,
  bearingDegrees,
  distanceNauticalMiles,
  groundTrackFromWaterTrack,
  heelFromWind,
  leewayDegrees,
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
  rateOfTurnDegPerMin,
  significantWaveHeight,
  trueWindAngle,
  trueWindFromApparent,
  wrapLongitude,
} from '../src/simulator/physics.js'
import { polarEfficiency, polarSpeedKnots } from '../src/simulator/boat.js'

const CLOSE = 1e-6

describe('angle helpers', () => {
  it('normalises to [0, 360)', () => {
    assert.equal(normalizeDegrees360(0), 0)
    assert.equal(normalizeDegrees360(360), 0)
    assert.equal(normalizeDegrees360(-1), 359)
    assert.equal(normalizeDegrees360(725), 5)
    assert.equal(normalizeDegrees360(-0), 0)
    assert.ok(!Object.is(normalizeDegrees360(-0), -0))
  })

  it('normalises to (-180, 180]', () => {
    assert.equal(normalizeDegrees180(0), 0)
    assert.equal(normalizeDegrees180(180), 180)
    assert.equal(normalizeDegrees180(181), -179)
    assert.equal(normalizeDegrees180(-190), 170)
  })

  it('takes the short way round when differencing', () => {
    assert.equal(angleDifference(350, 10), 20)
    assert.equal(angleDifference(10, 350), -20)
    assert.equal(angleDifference(0, 180), 180)
  })

  it('limits a turn to a maximum step', () => {
    assert.equal(approachAngle(350, 10, 5), 355)
    assert.equal(approachAngle(10, 350, 5), 5)
    assert.equal(approachAngle(350, 10, 90), 10, 'reaches the target when the step allows')
  })

  it('blends across the 0/360 boundary', () => {
    assert.equal(blendAngles(350, 10, 0.5), 0)
    assert.equal(blendAngles(10, 20, 0), 10)
    assert.equal(blendAngles(10, 20, 1), 20)
  })

  it('handles non-finite input without producing NaN', () => {
    assert.equal(normalizeDegrees360(Number.NaN), 0)
    assert.equal(clamp(Number.NaN, 1, 5), 1)
    assert.equal(roundTo(Number.POSITIVE_INFINITY, 2), 0)
  })

  it('interpolates with a clamped parameter', () => {
    assert.equal(lerp(0, 10, 0.5), 5)
    assert.equal(lerp(0, 10, -1), 0)
    assert.equal(lerp(0, 10, 2), 10)
  })

  it('produces a smoothing alpha in [0, 1]', () => {
    assert.equal(smoothingAlpha(1, 0), 1)
    assert.ok(smoothingAlpha(0.05, 12) > 0 && smoothingAlpha(0.05, 12) < 0.01)
    assert.ok(smoothingAlpha(100, 1) > 0.99)
  })
})

describe('polar vectors', () => {
  it('maps compass directions to north/east components', () => {
    const north = polarToVector(0, 10)
    assert.ok(Math.abs(north.north - 10) < CLOSE)
    assert.ok(Math.abs(north.east) < CLOSE)

    const east = polarToVector(90, 10)
    assert.ok(Math.abs(east.north) < CLOSE)
    assert.ok(Math.abs(east.east - 10) < CLOSE)

    const southwest = polarToVector(225, Math.SQRT2)
    assert.ok(Math.abs(southwest.north + 1) < CLOSE)
    assert.ok(Math.abs(southwest.east + 1) < CLOSE)
  })

  it('round-trips through vectorToPolar', () => {
    for (const direction of [0, 37, 90, 180, 271, 359]) {
      const polar = vectorToPolar(polarToVector(direction, 7.5))
      assert.ok(Math.abs(polar.magnitude - 7.5) < 1e-9)
      assert.ok(Math.abs(angleDifference(direction, polar.directionDegrees)) < 1e-9)
    }
  })

  it('reports a zero vector as zero rather than an arbitrary bearing', () => {
    assert.deepEqual(vectorToPolar({ north: 0, east: 0 }), { directionDegrees: 0, magnitude: 0 })
  })

  it('adds and subtracts component-wise', () => {
    assert.deepEqual(addVectors({ north: 1, east: 2 }, { north: 3, east: -1 }), { north: 4, east: 1 })
    assert.deepEqual(subtractVectors({ north: 1, east: 2 }, { north: 3, east: -1 }), { north: -2, east: 3 })
  })
})

describe('unit conversions', () => {
  it('converts knots to and from metres per second', () => {
    assert.ok(Math.abs(knotsToMetresPerSecond(1) - 0.5144444) < 1e-6)
    assert.ok(Math.abs(metresPerSecondToKnots(knotsToMetresPerSecond(12.3)) - 12.3) < 1e-9)
  })

  it('converts knots to km/h', () => {
    assert.ok(Math.abs(knotsToKilometresPerHour(10) - 18.52) < 1e-9)
  })

  it('converts metres to feet and fathoms', () => {
    assert.ok(Math.abs(metresToFeet(1) - 3.2808399) < 1e-6)
    assert.ok(Math.abs(metresToFathoms(1.8288) - 1) < 1e-9)
  })

  it('computes a plausible dew point below the air temperature', () => {
    const dewPoint = dewPointCelsius(20, 60)
    assert.ok(dewPoint < 20 && dewPoint > 10, `dew point ${dewPoint}`)
  })
})

describe('apparent wind', () => {
  it('adds boat speed to the true wind when sailing straight into it', () => {
    // Heading 0, moving north at 5 kn, true wind 10 kn from the north.
    const apparent = apparentWind(0, 10, 0, 5, 0)
    assert.ok(Math.abs(apparent.speedKnots - 15) < CLOSE, `AWS ${apparent.speedKnots}`)
    assert.ok(Math.abs(apparent.angleDegrees) < CLOSE, `AWA ${apparent.angleDegrees}`)
  })

  it('subtracts boat speed from the true wind on a dead run', () => {
    // Heading 0, moving north at 4 kn, true wind 10 kn from the south (behind).
    const apparent = apparentWind(180, 10, 0, 4, 0)
    assert.ok(Math.abs(apparent.speedKnots - 6) < CLOSE, `AWS ${apparent.speedKnots}`)
    assert.ok(Math.abs(normalizeDegrees180(apparent.angleDegrees - 180)) < CLOSE)
  })

  it('gives the Pythagorean result on a dead beam reach', () => {
    // True wind 12 kn from 90° (starboard beam), boat 5 kn due north.
    const apparent = apparentWind(90, 12, 0, 5, 0)
    assert.ok(Math.abs(apparent.speedKnots - Math.hypot(12, 5)) < CLOSE)
    // Apparent wind draws forward of the beam.
    assert.ok(apparent.angleDegrees > 0 && apparent.angleDegrees < 90, `AWA ${apparent.angleDegrees}`)
    assert.ok(Math.abs(apparent.angleDegrees - (Math.atan2(12, 5) * 180) / Math.PI) < 1e-9)
  })

  it('equals the true wind when the boat is stopped', () => {
    const apparent = apparentWind(240, 14, 145, 0, 145)
    assert.ok(Math.abs(apparent.speedKnots - 14) < CLOSE)
    assert.ok(Math.abs(angleDifference(apparent.directionDegreesTrue, 240)) < CLOSE)
    assert.ok(Math.abs(apparent.angleDegrees - 95) < 1e-9)
  })

  it('puts the wind on the correct side of the boat', () => {
    // Wind from 240 with the bow at 145: 95° off the starboard bow.
    const starboard = apparentWind(240, 14, 145, 6.1, 148)
    assert.ok(starboard.signedAngleDegrees > 0, 'starboard is positive')
    // Mirror the boat onto the other tack: heading 335 puts the wind to port.
    const port = apparentWind(240, 14, 335, 6.1, 335)
    assert.ok(port.signedAngleDegrees < 0, 'port is negative')
  })

  it('increases apparent wind as the boat accelerates on the same course', () => {
    const slow = apparentWind(240, 14, 145, 3, 145)
    const fast = apparentWind(240, 14, 145, 8, 145)
    assert.ok(fast.speedKnots > slow.speedKnots)
    assert.ok(fast.angleDegrees < slow.angleDegrees, 'apparent wind draws forward with speed')
  })

  it('never produces NaN, even from degenerate input', () => {
    for (const [twd, tws, heading, sog, cog] of [
      [0, 0, 0, 0, 0],
      [240, 0, 145, 0, 145],
      [-90, 14, 700, -5, -20],
    ] as const) {
      const apparent = apparentWind(twd, tws, heading, sog, cog)
      assert.ok(Number.isFinite(apparent.speedKnots))
      assert.ok(Number.isFinite(apparent.angleDegrees))
      assert.ok(Number.isFinite(apparent.directionDegreesTrue))
    }
  })

  it('round-trips back to the true wind', () => {
    for (const [twd, tws, heading, sog] of [
      [240, 14, 145, 6.1],
      [10, 25, 350, 8.4],
      [180, 6, 90, 2.2],
      [305, 38, 200, 7.3],
    ] as const) {
      const apparent = apparentWind(twd, tws, heading, sog, heading)
      const recovered = trueWindFromApparent(apparent.angleDegrees, apparent.speedKnots, heading, sog, heading)
      assert.ok(Math.abs(recovered.trueSpeedKnots - tws) < 1e-9, `TWS ${recovered.trueSpeedKnots} vs ${tws}`)
      assert.ok(Math.abs(angleDifference(recovered.directionDegrees, twd)) < 1e-9)
      assert.ok(Math.abs(angleDifference(recovered.angleDegrees, trueWindAngle(twd, heading))) < 1e-9)
    }
  })

  it('keeps true wind angle distinct from true wind direction', () => {
    // Wind from 240 with a heading of 145 is 95° off the bow — the two numbers
    // are different quantities and must not be confused.
    assert.equal(trueWindAngle(240, 145), 95)
    assert.equal(trueWindAngle(240, 335), 265)
  })
})

describe('ground track', () => {
  it('equals the water track when there is no current', () => {
    const track = groundTrackFromWaterTrack(145, 5.8, 0, 0)
    assert.ok(Math.abs(track.sogKnots - 5.8) < CLOSE)
    assert.ok(Math.abs(angleDifference(track.cogDegrees, 145)) < CLOSE)
  })

  it('adds a fair current to the speed over ground', () => {
    const track = groundTrackFromWaterTrack(90, 6, 90, 1.5)
    assert.ok(Math.abs(track.sogKnots - 7.5) < CLOSE)
    assert.ok(Math.abs(angleDifference(track.cogDegrees, 90)) < CLOSE)
  })

  it('subtracts a foul current', () => {
    const track = groundTrackFromWaterTrack(90, 6, 270, 2)
    assert.ok(Math.abs(track.sogKnots - 4) < CLOSE)
  })

  it('sets the course away from the heading in a cross current', () => {
    const track = groundTrackFromWaterTrack(0, 5, 90, 1)
    assert.ok(track.cogDegrees > 0 && track.cogDegrees < 90, `COG ${track.cogDegrees}`)
    assert.ok(track.sogKnots > 5, 'a beam current still adds a little speed')
  })

  it('holds the water track rather than jittering when stationary', () => {
    const track = groundTrackFromWaterTrack(145, 0, 0, 0)
    assert.equal(track.sogKnots, 0)
    assert.equal(track.cogDegrees, 145)
  })
})

describe('position integration', () => {
  it('moves one nautical mile north in one hour at one knot', () => {
    const start = { latitude: 0, longitude: 0 }
    const end = advancePosition(start, 0, 1, 3600)

    // The integrator works in metres against the local WGS84 scale factor, so
    // that is what the displacement is checked against.
    const expectedDegrees = 1852 / metresPerDegreeLatitude(0)
    assert.ok(Math.abs(end.latitude - expectedDegrees) < 1e-9, `moved ${end.latitude}°`)
    assert.ok(end.latitude > 0)
    assert.ok(Math.abs(end.longitude) < 1e-9)

    // The spherical haversine helper uses a different Earth model, so it agrees
    // to within a fraction of a percent rather than exactly.
    const distance = distanceNauticalMiles(start, end)
    assert.ok(Math.abs(distance - 1) < 0.01, `haversine reported ${distance} nm`)
  })

  it('moves east along a course of 090', () => {
    const start = { latitude: 41.95, longitude: -70.3 }
    const end = advancePosition(start, 90, 10, 600)
    assert.ok(end.longitude > start.longitude)
    assert.ok(Math.abs(end.latitude - start.latitude) < 1e-9)
    assert.ok(Math.abs(bearingDegrees(start, end) - 90) < 0.1)
  })

  it('accumulates the same distance in many small steps as in one big one', () => {
    const start = { latitude: 41.95, longitude: -70.3 }
    const oneStep = advancePosition(start, 145, 6.1, 600)
    let stepped = start
    for (let index = 0; index < 600; index += 1) {
      stepped = advancePosition(stepped, 145, 6.1, 1)
    }
    assert.ok(distanceNauticalMiles(oneStep, stepped) < 0.001)
  })

  it('does nothing for a zero or negative time step', () => {
    const start = { latitude: 41.95, longitude: -70.3 }
    assert.deepEqual(advancePosition(start, 145, 6.1, 0), start)
    assert.deepEqual(advancePosition(start, 145, 6.1, -5), start)
  })

  it('wraps longitude across the antimeridian', () => {
    const start = { latitude: 0, longitude: 179.999 }
    const end = advancePosition(start, 90, 60, 3600)
    assert.ok(end.longitude < 0, `wrapped to ${end.longitude}`)
    assert.ok(end.longitude >= -180 && end.longitude < 180)
  })

  it('keeps longitude in range', () => {
    assert.equal(wrapLongitude(180), -180)
    assert.equal(wrapLongitude(-180), -180)
    assert.equal(wrapLongitude(190), -170)
    assert.equal(wrapLongitude(-0), 0)
  })

  it('uses latitude-dependent scale factors', () => {
    assert.ok(metresPerDegreeLatitude(0) < metresPerDegreeLatitude(60), 'meridian lengthens toward the poles')
    assert.ok(metresPerDegreeLongitude(60) < metresPerDegreeLongitude(0), 'parallels shorten toward the poles')
    assert.ok(Math.abs(metresPerDegreeLatitude(0) - 110574) < 50)
    assert.ok(Math.abs(metresPerDegreeLongitude(0) - 111320) < 50)
  })
})

describe('rate of turn', () => {
  it('reports degrees per minute', () => {
    assert.ok(Math.abs(rateOfTurnDegPerMin(0, 1, 1) - 60) < CLOSE)
    assert.ok(Math.abs(rateOfTurnDegPerMin(0, -1, 1) + 60) < CLOSE)
  })

  it('takes the short way round the compass', () => {
    assert.ok(Math.abs(rateOfTurnDegPerMin(359, 1, 1) - 120) < CLOSE)
  })

  it('returns zero rather than infinity for a zero time step', () => {
    assert.equal(rateOfTurnDegPerMin(0, 10, 0), 0)
  })
})

describe('heel and leeway', () => {
  it('heels to leeward, and the other way on the other tack', () => {
    const starboardTack = heelFromWind(60, 18, 26, 30)
    const portTack = heelFromWind(300, 18, 26, 30)
    assert.ok(starboardTack > 0)
    assert.ok(portTack < 0)
    assert.ok(Math.abs(starboardTack + portTack) < 1e-9, 'symmetric about the bow')
  })

  it('heels more in more wind and is bounded', () => {
    assert.ok(heelFromWind(60, 25, 26, 30) > heelFromWind(60, 12, 26, 30))
    assert.ok(Math.abs(heelFromWind(60, 90, 26, 30)) <= 30)
  })

  it('does not heel head to wind or dead downwind', () => {
    assert.ok(Math.abs(heelFromWind(0, 20, 26, 30)) < CLOSE)
    assert.ok(Math.abs(heelFromWind(180, 20, 26, 30)) < CLOSE)
  })

  it('makes leeway to leeward, and none under power', () => {
    // Wind on the starboard bow heels to starboard and pushes the boat to port.
    const leeway = leewayDegrees(45, 18, 5.5, 9)
    assert.ok(leeway < 0, `leeway ${leeway}`)
    assert.equal(leewayDegrees(45, 18, 5.5, 0), 0, 'no leeway coefficient, no leeway')
  })

  it('makes less leeway as the boat speeds up', () => {
    assert.ok(Math.abs(leewayDegrees(45, 18, 8, 9)) < Math.abs(leewayDegrees(45, 18, 4, 9)))
  })

  it('stays finite and bounded at zero boat speed', () => {
    const leeway = leewayDegrees(45, 25, 0, 9)
    assert.ok(Number.isFinite(leeway))
    assert.ok(Math.abs(leeway) <= 12)
  })
})

describe('sailing polar', () => {
  it('is near zero in irons and peaks on a reach', () => {
    assert.ok(polarEfficiency(10) < 0.1, 'head to wind')
    assert.ok(polarEfficiency(90) > polarEfficiency(40), 'reaching beats beating')
    assert.ok(polarEfficiency(110) > polarEfficiency(175), 'reaching beats running')
  })

  it('is symmetric between tacks', () => {
    for (const angle of [35, 60, 95, 140, 178]) {
      assert.ok(Math.abs(polarEfficiency(angle) - polarEfficiency(360 - angle)) < 1e-12, `angle ${angle}`)
    }
  })

  it('increases boat speed with wind speed but respects the hull-speed ceiling', () => {
    const light = polarSpeedKnots(6, 95, 7.6)
    const moderate = polarSpeedKnots(14, 95, 7.6)
    const gale = polarSpeedKnots(45, 95, 7.6)
    assert.ok(moderate > light)
    assert.ok(gale > moderate)
    assert.ok(gale < 7.6 * 1.01, `hull speed exceeded: ${gale}`)
  })

  it('gives zero boat speed in zero wind', () => {
    assert.equal(polarSpeedKnots(0, 95, 7.6), 0)
  })
})

describe('sea state', () => {
  it('builds waves with wind and is bounded', () => {
    assert.equal(significantWaveHeight(0, 1), 0)
    assert.ok(significantWaveHeight(35, 1) > significantWaveHeight(12, 1))
    assert.ok(significantWaveHeight(90, 2) <= 14)
  })

  it('produces smaller waves in sheltered water', () => {
    assert.ok(significantWaveHeight(25, 0.2) < significantWaveHeight(25, 1.5))
  })
})
