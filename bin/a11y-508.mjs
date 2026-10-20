#!/usr/bin/env node
import { main } from '../src/cli.mjs';

process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // The command is over: a handle left open (a browser connection, a timer) must not keep the process
    // alive, or the dashboard shows the run as still running. Unref'd, so a clean exit is not delayed.
    setTimeout(() => process.exit(code), 3000).unref();
  },
  (err) => {
    process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  }
);
