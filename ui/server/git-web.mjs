// The repository's web address now lives in the core (src/git-web.mjs), which the manual flow's
// decision log uses for its commit links; the server keeps importing it from here.
export { webRemote, remoteWeb } from '../../src/git-web.mjs';
