// Build a separate production-mode bundle, then serve it on loopback only.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSanitizedEnvironment, validateClientConfig } from '../../scripts/client-config.mjs';
import { browserOrigin, clientConfig } from './settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientRoot = path.join(root, 'client');
const buildDirectory = path.resolve(clientRoot, 'dist-browser');
// Vite empties this directory recursively. Check its absolute target before
// allowing cleanup, and never follow a user-created symlink/junction.
if (path.dirname(buildDirectory) !== clientRoot || lstatSync(clientRoot).isSymbolicLink()) {
  throw new Error('Unsafe browser build target');
}
try {
  const stat = lstatSync(buildDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe browser build directory');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const environment = buildSanitizedEnvironment(process.env, validateClientConfig(clientConfig));

for (const args of [
  [requireClient.resolve('typescript/bin/tsc'), '-p', path.join(clientRoot, 'tsconfig.json')],
  [path.join(path.dirname(requireClient.resolve('vite/package.json')), 'bin/vite.js'),
    'build', clientRoot, '--config', path.join(clientRoot, 'vite.config.ts'),
    '--outDir', buildDirectory, '--emptyOutDir']
]) {
  const result = spawnSync(process.execPath, args, {cwd: root, env: environment, stdio: 'inherit', shell: false});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

const { preview } = await import(pathToFileURL(requireClient.resolve('vite')).href);
const address = new URL(browserOrigin);
const server = await preview({
  root: clientRoot,
  configFile: false,
  envDir: false,
  build: {outDir: buildDirectory},
  preview: {host: address.hostname, port: Number(address.port), strictPort: true}
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.httpServer.close(() => process.exit(0)));
}
