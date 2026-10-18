import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: 'postcode' });
  const { holder, refresh } = await bootstrap(config, logger);
  const app = createApp(holder, config, logger);
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('listening', { port: info.port, refreshMs: config.refreshMs, source: config.indexSource });
  });
  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    refresh.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
