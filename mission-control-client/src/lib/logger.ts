import pino from 'pino'

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

// Next.js dev workers are prone to crashing with transport-backed stdout logging.
// Keep local client logs simple in dev so bridge/session background handlers stay alive.
const disablePrettyTransport = process.env.NEXT_RUNTIME === 'nodejs' || process.env.NODE_ENV !== 'production'
const usePretty = !disablePrettyTransport && hasPinoPretty()

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(usePretty && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
})
