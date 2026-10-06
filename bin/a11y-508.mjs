#!/usr/bin/env node
import { main } from '../src/cli.mjs';

process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  }
);
