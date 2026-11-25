import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
for (const name of ['ledger', 'trading']) for (const file of readdirSync(resolve('packages', name))) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', resolve('packages', name, file)], { stdio: 'inherit' });
for (const name of ['ledger', 'trading', 'preset']) JSON.parse(readFileSync(resolve('packages', name, 'package.json'), 'utf8'));
for (const folder of ['apps/pi-trader', 'apps/pi-trader/web', '.pi/extensions']) for (const file of readdirSync(resolve(folder))) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', resolve(folder, file)], { stdio: 'inherit' });
JSON.parse(readFileSync('package.json','utf8'));
console.log('Pi application, legacy packages and manifests checked.');
