/**
 * AIS message construction.
 *
 * Only message type 1 (Position Report Class A) is implemented — enough to
 * exercise a consumer's AIS path with own-ship (`!AIVDO`) and target
 * (`!AIVDM`) reports. AIS is optional and off by default; nothing else in the
 * simulator depends on it.
 */

import { normalizeDegrees360 } from '../../core/math.js'
import type { AisTargetSample } from '../../simulator/instruments.js'
import { BitWriter } from './sixbit.js'

/** AIS encodes rate of turn as `4.733 * sqrt(deg/min)`, signed. */
export function encodeRateOfTurn(degreesPerMinute: number): number {
  if (!Number.isFinite(degreesPerMinute)) return -128
  const magnitude = Math.min(708, Math.abs(degreesPerMinute))
  const encoded = Math.round(4.733 * Math.sqrt(magnitude)) * Math.sign(degreesPerMinute)
  return Math.max(-127, Math.min(127, encoded))
}

export interface PositionReportOptions {
  target: AisTargetSample
  /** UTC second of the report (0-59); 60 means unavailable. */
  utcSecond: number
  repeatIndicator?: number
}

/**
 * Build a type 1 position report as a six-bit armoured payload.
 * The message is exactly 168 bits, so it always fits in one sentence.
 */
export function buildPositionReport({ target, utcSecond, repeatIndicator = 0 }: PositionReportOptions): {
  payload: string
  fillBits: number
} {
  const writer = new BitWriter()
  writer.unsigned(1, 6) // message type 1
  writer.unsigned(repeatIndicator, 2)
  writer.unsigned(target.mmsi, 30)
  writer.unsigned(target.navigationStatus, 4)
  writer.signed(encodeRateOfTurn(target.rateOfTurnDegPerMin), 8)
  // Speed over ground in tenths of a knot; 1023 means "not available".
  writer.unsigned(Math.min(1022, Math.round(Math.max(0, target.sogKnots) * 10)), 10)
  writer.unsigned(0, 1) // position accuracy: low (> 10 m)
  // Position in 1/10000 minutes.
  writer.signed(Math.round(target.longitude * 600000), 28)
  writer.signed(Math.round(target.latitude * 600000), 27)
  writer.unsigned(Math.min(3599, Math.round(normalizeDegrees360(target.cogDegrees) * 10)), 12)
  writer.unsigned(Math.min(359, Math.round(normalizeDegrees360(target.headingTrue))), 9)
  writer.unsigned(Math.min(63, Math.max(0, Math.round(utcSecond))), 6)
  writer.unsigned(0, 2) // special manoeuvre indicator: not available
  writer.unsigned(0, 3) // spare
  writer.unsigned(0, 1) // RAIM not in use
  writer.unsigned(0, 19) // radio status
  return writer.toPayload()
}

/**
 * Build the body of a VDM/VDO sentence for a single-part message.
 *
 * @param formatter `VDM` for other vessels, `VDO` for own ship.
 * @param channel   AIS radio channel, `A` or `B`.
 */
export function buildVdmBody(
  formatter: 'VDM' | 'VDO',
  payload: string,
  fillBits: number,
  channel: 'A' | 'B' = 'A',
): string {
  return [formatter, '1', '1', '', channel, payload, String(fillBits)].join(',')
}
