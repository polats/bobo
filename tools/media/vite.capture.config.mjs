// Dev server for captures: no HMR or file watching, so edits elsewhere can't reload a page mid-recording.
import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  base: './',
  server: { port: 5320, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
};
