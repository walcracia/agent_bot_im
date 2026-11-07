// Official Desktop packs its dsh dependency graph inside app.asar. Resolve the
// separately published, same-version SDK against that graph without copying or
// modifying upstream JavaScript, installing a second CLI, or changing PATH.
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../environment/tools/dsh/', import.meta.url));
const desktopRequire = createRequire(resolve(root, 'desktop/resources/app.asar/dsh/package.json'));
const sdk = pathToFileURL(resolve(root, 'sdk-client/package/lib/index.js')).href;
let resolving = false;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-sdk-client') return { url: sdk, shortCircuit: true };
  if (specifier.startsWith('@deepseek-ai/') && !resolving) {
    resolving = true;
    try { return { url: pathToFileURL(desktopRequire.resolve(specifier)).href, shortCircuit: true }; }
    finally { resolving = false; }
  }
  return nextResolve(specifier, context);
} });
