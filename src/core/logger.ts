/**
 * Minimal levelled logger.
 *
 * Console output has to stay useful without flooding the terminal: instrument
 * updates happen up to ten times a second, and printing them all makes the
 * simulator unusable during development. Sentence-level logging is therefore
 * opt-in (`LOG_NMEA` / `--verbose`); everything else is events only.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export interface Logger {
  error(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  debug(message: string, ...rest: unknown[]): void
  /** Write a line with no level prefix (banners, dashboards, raw sentences). */
  write(message: string): void
  readonly level: LogLevel
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const enabled = (required: LogLevel): boolean => PRIORITY[level] >= PRIORITY[required]
  const format = (tag: string, message: string, rest: unknown[]): string => {
    const extra = rest.length > 0 ? ` ${rest.map((value) => stringify(value)).join(' ')}` : ''
    return `${tag} ${message}${extra}`
  }

  return {
    level,
    error(message, ...rest) {
      if (enabled('error')) sink(format('[error]', message, rest))
    },
    warn(message, ...rest) {
      if (enabled('warn')) sink(format('[warn] ', message, rest))
    },
    info(message, ...rest) {
      if (enabled('info')) sink(format('[info] ', message, rest))
    },
    debug(message, ...rest) {
      if (enabled('debug')) sink(format('[debug]', message, rest))
    },
    write(message) {
      if (level !== 'silent') sink(message)
    },
  }
}

/** A logger that discards everything; used by tests. */
export const silentLogger: Logger = createLogger('silent', () => {})

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
