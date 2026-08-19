/**
 * Controlled sensor failure.
 *
 * The most important scenario for testing a consumer, and the one with the
 * strictest determinism requirement: the same seed replays the same failures at
 * the same simulated seconds, every time, so a regression test can assert on
 * them.
 *
 * The timeline exercises each failure mode separately, restores the sensor
 * before moving to the next, and then repeats:
 *
 *   0:20  wind stops updating (frozen — sentences continue, values do not)
 *   0:35  wind returns
 *   0:50  GPS disappears entirely (no RMC/GGA/VTG at all)
 *   1:10  GPS returns
 *   1:25  heading freezes
 *   1:45  heading returns
 *   2:00  depth goes stale
 *   2:20  depth returns
 *   2:35  five sentences carry a bad checksum
 *   2:45  one malformed sentence
 *   2:55  GPS reports an invalid fix (RMC status V, GGA quality 0)
 *   3:15  everything returns to normal
 *   3:40  the timeline repeats
 */

import type { Random } from '../core/random.js'
import type { FaultTimeline } from '../simulator/faults.js'
import { environment, vessel } from './defaults.js'
import type { ScenarioDefinition, ScenarioInstance } from './types.js'

export const SENSOR_FAILURE_TIMELINE: FaultTimeline = {
  loopSeconds: 220,
  events: [
    { atSeconds: 20, action: { type: 'instrument', instrument: 'wind', fault: 'frozen' }, note: 'wind stopped updating' },
    { atSeconds: 35, action: { type: 'instrument', instrument: 'wind', fault: 'none' }, note: 'wind sensor returned' },
    { atSeconds: 50, action: { type: 'instrument', instrument: 'gps', fault: 'offline' }, note: 'GPS disappeared' },
    { atSeconds: 70, action: { type: 'instrument', instrument: 'gps', fault: 'none' }, note: 'GPS returned' },
    { atSeconds: 85, action: { type: 'instrument', instrument: 'heading', fault: 'frozen' }, note: 'heading frozen' },
    { atSeconds: 105, action: { type: 'instrument', instrument: 'heading', fault: 'none' }, note: 'heading returned' },
    { atSeconds: 120, action: { type: 'instrument', instrument: 'depth', fault: 'frozen' }, note: 'depth stale' },
    { atSeconds: 140, action: { type: 'instrument', instrument: 'depth', fault: 'none' }, note: 'depth returned' },
    { atSeconds: 155, action: { type: 'badChecksum', count: 5 }, note: 'bad checksums injected' },
    { atSeconds: 165, action: { type: 'malformed', count: 1 }, note: 'malformed sentence injected' },
    { atSeconds: 175, action: { type: 'instrument', instrument: 'gps', fault: 'invalid' }, note: 'GPS fix invalid' },
    { atSeconds: 195, action: { type: 'clearAll' }, note: 'all sensors restored' },
  ],
}

export const sensorFailure: ScenarioDefinition = {
  name: 'sensor-failure',
  label: 'Sensor failure',
  description:
    'A vessel under way while instruments fail on a fixed, repeatable schedule: frozen wind, GPS dropout, frozen heading, stale depth, bad checksums, a malformed sentence, an invalid fix, then full recovery.',
  highlights: [
    'deterministic fault timeline',
    'loops every 220 s',
    'frozen / offline / invalid instruments',
    'bad checksum and malformed sentence injection',
  ],
  create(random: Random): ScenarioInstance {
    void random
    return {
      setup: {
        vessel: vessel({
          propulsion: 'motor',
          headingDegrees: 120,
          targetSpeedKnots: 8.5,
          speedSigmaKnots: 0.25,
          headingWanderSigmaDegrees: 1.8,
          heelStiffness: 80,
          maxHeelDegrees: 10,
          leewayCoefficient: 0,
          hullSpeedKnots: 12,
        }),
        environment: environment({
          wind: { directionDegrees: 195, speedKnots: 12 },
          current: { setDegrees: 100, driftKnots: 0.5 },
          seabed: { depthMeters: 18, depthVariationMeters: 4 },
        }),
        nominalTrueWindSpeedKnots: 12,
        aisTargetCount: 2,
      },
      faults: SENSOR_FAILURE_TIMELINE,
    }
  },
}
