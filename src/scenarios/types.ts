/**
 * Scenario contract.
 *
 * A scenario supplies the initial world (vessel + environment), an optional
 * deterministic fault timeline, and an optional per-tick behaviour that steers
 * the boat — tacking, altering course, riding out a storm.
 *
 * Scenarios never write sentences and never touch a transport. They shape the
 * world; everything downstream follows from that.
 */

import type { Random } from '../core/random.js'
import type { FaultTimeline } from '../simulator/faults.js'
import type { World, WorldSetup } from '../simulator/world.js'

export const SCENARIO_NAMES = ['sailing', 'cruising', 'anchored', 'storm', 'sensor-failure'] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value)
}

export interface ScenarioInstance {
  setup: WorldSetup
  faults?: FaultTimeline | undefined
  /**
   * Called on every physics tick. Use it to steer, trim and otherwise act on
   * the world; it must stay deterministic for a given seed.
   */
  update?(world: World, dtSeconds: number, elapsedSeconds: number): void
}

export interface ScenarioDefinition {
  name: ScenarioName
  label: string
  description: string
  /** Summary shown by `GET /scenarios`, e.g. the starting conditions. */
  highlights: readonly string[]
  create(random: Random): ScenarioInstance
}
