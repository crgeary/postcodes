#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from './build.js';
import { inspect } from './inspect.js';
import { DEFAULT_PRECISION_THRESHOLD_M, districtsOverThreshold, formatReport } from './report.js';

const USAGE = `Usage:
  postcode-index build [options] -o <output.idx> <onspd.csv>...
  postcode-index inspect [--precision-threshold <m>] <index.idx>

Build options:
  -o, --output <file>             Output index file (required)
      --release <label>           Release label, e.g. FEB_2026 (default: from file name)
      --exclude-ni                Drop Northern Ireland (country N92000002)
      --exclude-crown-dependencies
                                  Drop Channel Islands (L93000001) and Isle of Man (M83000003)
      --gb-only                   Both exclusions above
      --precision-threshold <m>   Alert threshold in metres (default ${DEFAULT_PRECISION_THRESHOLD_M})
  -q, --quiet                     No progress output
  -h, --help
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'build') return runBuild(argv.slice(1));
  if (command === 'inspect') return runInspect(argv.slice(1));
  fail(`unknown command "${command}"\n\n${USAGE}`);
}

async function runBuild(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      release: { type: 'string' },
      'exclude-ni': { type: 'boolean', default: false },
      'exclude-crown-dependencies': { type: 'boolean', default: false },
      'gb-only': { type: 'boolean', default: false },
      'precision-threshold': { type: 'string' },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.output) fail('build requires -o <output.idx>');
  if (positionals.length === 0) fail('build requires at least one ONSPD CSV file');
  const threshold = values['precision-threshold'] !== undefined ? Number(values['precision-threshold']) : undefined;
  if (threshold !== undefined && !(threshold > 0)) fail('--precision-threshold must be a positive number');

  const started = Date.now();
  const outcome = await build({
    inputs: positionals,
    output: values.output,
    release: values.release,
    excludeNorthernIreland: values['exclude-ni'] || values['gb-only'],
    excludeCrownDependencies: values['exclude-crown-dependencies'] || values['gb-only'],
    precisionThresholdM: threshold,
    onProgress: values.quiet
      ? undefined
      : (c) => process.stderr.write(`  ${c.rows.toLocaleString('en-GB')} rows, ${c.live.toLocaleString('en-GB')} live\n`),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`Wrote ${values.output} in ${seconds}s\n`);
  process.stdout.write(
    formatReport(outcome.index.metadata, outcome.index, outcome.fileBytes, outcome.thresholdM, outcome.precision) + '\n',
  );
  if (outcome.counts.invalid > 0) {
    process.stderr.write(`warning: ${outcome.counts.invalid} invalid rows; the ONSPD format may have changed\n`);
  }
  const over = districtsOverThreshold(outcome.precision, outcome.thresholdM);
  return over.length > 0 ? 1 : 0;
}

async function runInspect(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'precision-threshold': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) fail('inspect takes exactly one index file');
  const threshold = values['precision-threshold'] !== undefined ? Number(values['precision-threshold']) : undefined;
  let result;
  try {
    result = inspect(positionals[0], threshold);
  } catch (err) {
    fail(`${positionals[0]}: ${(err as Error).message}`, 1);
  }
  process.stdout.write(result.text + '\n');
  return 0;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => fail((err as Error).stack ?? String(err), 1),
  );
}
