import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: 'postcode' });
  const { holder, refresh } = await bootstrap(config, logger);
  const app = createApp(holder, config, logger);
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('listening', { port: info.port, refreshMs: config.refreshMs, source: config.indexSource });
  });
  const shutdown = createShutdown({
    holder,
    refresh,
    logger,
    drainMs: config.shutdownDrainMs,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
