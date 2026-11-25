import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const args=process.argv.slice(2), options={};
for(let i=0;i<args.length;i+=2){if(!['--harness','--home','--profile'].includes(args[i])||!args[i+1])throw Error('Use --harness <Harness source directory> --home <DSH_HOME> [--profile web]');options[args[i]]=args[i+1];}
if(!options['--harness']||!options['--home'])throw Error('Both --harness and --home are required');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),harness=resolve(options['--harness']),home=resolve(options['--home']),profile=options['--profile']??'web';
if(!/^[a-zA-Z0-9_-]+$/.test(profile))throw Error('Invalid profile name');
if(!existsSync(resolve(harness,'apps/cli/src/bin.ts')))throw Error('Not a Harness source checkout');
const harnessPackage=JSON.parse(readFileSync(resolve(harness,'package.json'),'utf8'));
if(harnessPackage.version!=='0.2.1-alpha.2')throw Error('This release is verified against Harness 0.2.1-alpha.2; select that checkout before installing. Found: '+harnessPackage.version);
if(!existsSync(resolve(harness,'node_modules/tsx')))throw Error('Harness dependencies are not installed; prepare the supported checkout first.');
execFileSync(process.execPath,[resolve(root,'scripts/pack.mjs')],{stdio:'inherit'});
const backup=resolve(home,'backups','before-options-workbench-'+new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(backup,{recursive:true,mode:0o700});
for(const name of ['package.json','pnpm-lock.yaml','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml']){const path=resolve(home,'profiles',profile,name);if(existsSync(path))copyFileSync(path,resolve(backup,name));}
// A local tarball path is a package-manager cache key. Include content in the path so
// re-installing a reviewed local build cannot silently retain bytes from an older pack.
const tarballs=['preset','ledger','trading'].map(name=>{const p=JSON.parse(readFileSync(resolve(root,'packages',name,'package.json'),'utf8'));const base=p.name.replace(/^@/,'').replace('/','-')+'-'+p.version;const path=resolve(root,'dist',base+'.tgz');const digest=createHash('sha256').update(readFileSync(path)).digest('hex').slice(0,16);const addressed=resolve(root,'dist',base+'-'+digest+'.tgz');copyFileSync(path,addressed);return addressed;});
execFileSync(process.execPath,['--import','tsx/esm','apps/cli/src/bin.ts','plugin','--profile',profile,'add',...tarballs],{cwd:harness,env:{...process.env,DSH_HOME:home},stdio:'inherit'});
console.log('Installed. Existing ledger storage remains under the same DSH_HOME. Profile backup:',backup);
console.log('Start this profile from the Harness directory using your existing DSH_HOME and port. An already running host may require a restart to load package updates. This installer does not stop it.');
console.log('After startup, verify all three bundles are enabled in Plugins. An earlier failed installation may have left an installed dependency disabled.');
