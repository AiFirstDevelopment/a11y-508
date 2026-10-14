// The dashboard's own browser as real Chrome, headless (A11Y_508_OWN_BROWSER_PATH; a .mjs path is
// run with Node): it starts Chrome with the arguments the server gives plus --headless=new, so a
// test drives real tabs over the DevTools port without a window on screen. Chrome is killed when
// this process or the server that started it goes away.

import { spawn } from 'node:child_process';
import { findChrome } from '../../../src/chrome.mjs';

const chrome = spawn(findChrome(), ['--headless=new', '--disable-gpu', ...process.argv.slice(2)], { stdio: 'ignore' });
const end = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {}
  process.exit(0);
};
chrome.on('exit', () => process.exit(0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, end);
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    end();
  }
}, 500);
