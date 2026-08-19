/**
 * Scenario registry.
 */

import { anchored } from './anchored.js'
import { cruising } from './cruising.js'
import { sailing } from './sailing.js'
import { sensorFailure } from './sensorFailure.js'
import { storm } from './storm.js'
import type { ScenarioDefinition, ScenarioName } from './types.js'

const DEFINITIONS: readonly ScenarioDefinition[] = [sailing, cruising, anchored, storm, sensorFailure]

export const SCENARIOS: ReadonlyMap<ScenarioName, ScenarioDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.name, definition]),
)

export function getScenario(name: ScenarioName): ScenarioDefinition {
  const definition = SCENARIOS.get(name)
  if (!definition) throw new Error(`Unknown scenario: ${name}`)
  return definition
}

export function listScenarios(): ScenarioDefinition[] {
  return [...SCENARIOS.values()]
}

export { SCENARIO_NAMES, isScenarioName } from './types.js'
export type { ScenarioDefinition, ScenarioInstance, ScenarioName } from './types.js'
