/**
 * Two outputs:
 *   lib/index.js   host half, plain Node ESM, imported by the Loader.
 *   lib/client.js  browser half, CJS in closure-factory form — a shape dictated by dsh's
 *                  module table, not chosen: on execution the bundle calls
 *                  window.__ModuleLoader__.load({id, factory}), and external deps come
 *                  from the host module table via an injected require (no globals, no
 *                  import map). See the harness packages/client/tsdown.client.ts.
 */

import { defineConfig } from 'tsdown'

/** Package name, and the entry id in the module table — must match package.json's name. */
const ID = 'dsh-pocket'

/**
 * Modules the host shares through the module table. These stay external and are resolved
 * by the injected require; everything else — including this package's own dependencies —
 * must be inlined, because the table cannot answer for them.
 * Kept in sync with the harness PLATFORM_MODULES.
 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    clean: true,
    /*
     * Bundle dependencies in, so the output has zero runtime dependencies.
     *
     * Distribution dictates this: after cloning, users run `pnpm add <local directory>`,
     * which only creates a symlink and never installs that directory's own dependencies —
     * so the host half's imports find nothing and dsh fails to start. Bundling removes the
     * problem, and the package works the same via clone, npm or tarball.
     */
    noExternal: (id: string) => !id.startsWith('node:'),
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2023',
    dts: false,
    // The output is committed; sourcemaps are half the size and useless to consumers.
    sourcemap: false,
    // The host half was just written to lib/; cleaning again here would delete it.
    clean: false,
    external: EXTERNALS,
    // tsdown externalises dependencies by default, but the module table cannot answer for
    // anything beyond the list above — inline everything else, or require throws at runtime.
    noExternal: (id: string) => (EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
