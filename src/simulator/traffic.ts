/**
 * Simulated AIS traffic.
 *
 * Optional: AIS is disabled by default and nothing else depends on it. It
 * exists so that the AIS encoder has real, moving targets to describe, and so
 * that a consumer can be exercised with `!AIVDM` / `!AIVDO` sentences without a
 * second data source.
 */

import { normalizeDegrees360 } from '../core/math.js'
import { OrnsteinUhlenbeck, Random } from '../core/random.js'
import { advancePosition, type GeoPosition } from './physics.js'
import type { AisTargetSample } from './instruments.js'

interface TrafficVessel {
  mmsi: number
  name: string
  position: GeoPosition
  courseDegrees: number
  speedKnots: number
  navigationStatus: number
  wander: OrnsteinUhlenbeck
  previousHeading: number
}

const VESSEL_NAMES = ['NORDIC STAR', 'SEA HARRIER', 'BLUE PETREL', 'CAPE RUNNER', 'ORCA BAY', 'MERIDIAN'] as const

export class AisTraffic {
  private readonly vessels: TrafficVessel[] = []

  constructor(origin: GeoPosition, count: number, random: Random) {
    for (let index = 0; index < Math.max(0, count); index += 1) {
      const bearing = random.range(0, 360)
      const rangeNm = random.range(0.6, 5)
      const start = advancePosition(origin, bearing, rangeNm * 3600, 1)
      this.vessels.push({
        mmsi: 200000000 + random.integer(100000, 999999),
        name: VESSEL_NAMES[index % VESSEL_NAMES.length] ?? `TARGET ${index + 1}`,
        position: start,
        courseDegrees: random.range(0, 360),
        speedKnots: random.range(4, 16),
        // 0 = under way using engine, 5 = moored, 8 = under way sailing.
        navigationStatus: random.chance(0.2) ? 8 : 0,
        wander: new OrnsteinUhlenbeck(random.derive(`traffic-${index}`), {
          mean: 0,
          sigma: 6,
          timeConstantSeconds: 120,
        }),
        previousHeading: 0,
      })
    }
  }

  step(dtSeconds: number): void {
    for (const vessel of this.vessels) {
      vessel.wander.step(dtSeconds)
      vessel.previousHeading = normalizeDegrees360(vessel.courseDegrees + vessel.wander.value)
      vessel.position = advancePosition(vessel.position, vessel.previousHeading, vessel.speedKnots, dtSeconds)
    }
  }

  samples(): AisTargetSample[] {
    return this.vessels.map((vessel) => ({
      mmsi: vessel.mmsi,
      name: vessel.name,
      latitude: vessel.position.latitude,
      longitude: vessel.position.longitude,
      cogDegrees: vessel.previousHeading,
      sogKnots: vessel.speedKnots,
      headingTrue: vessel.previousHeading,
      rateOfTurnDegPerMin: 0,
      navigationStatus: vessel.navigationStatus,
    }))
  }

  get count(): number {
    return this.vessels.length
  }
}
