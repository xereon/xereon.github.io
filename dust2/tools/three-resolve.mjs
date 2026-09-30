// Node ESM hook so tests can `import 'three'` against the vendored build.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./three-hooks.mjs', pathToFileURL(new URL('.', import.meta.url).pathname));
