import pino from 'pino';

export function createLogger(config, dev) {
  const level = process.env.LOG_LEVEL || config.log?.level || 'info';
  if (!dev) return pino({ level });
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId,status,ms' },
    },
  });
}
