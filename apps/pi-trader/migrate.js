/** Copy legacy databases into a new home as one directory publication; never change source data. */
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync, mkdtempSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { requireThat } from '../../packages/trading/errors.js';
export async function migrateLegacy({ sourceHome, home, backupFn=backup }) {
  const source=resolve(sourceHome),destination=resolve(home);
  requireThat(!existsSync(destination),'TARGET_NOT_EMPTY','迁移目标必须为尚不存在的新目录，不覆盖已有数据。',409);
  const pairs=[['data/options-ledger/ledger.sqlite','ledger.sqlite'],['data/trading-workbench/workbench.sqlite','workbench.sqlite']];
  for(const [from]of pairs)requireThat(existsSync(join(source,from)),'SOURCE_MISSING','缺少源数据库，未开始迁移。',404);
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const staging=mkdtempSync(join(dirname(destination),'.pi-migrate-'));chmodSync(staging,0o700);
  let published=false;
  try{
    for(const [from,to]of pairs){
      const db=new DatabaseSync(join(source,from),{readOnly:true});
      try{await backupFn(db,join(staging,to));}finally{db.close();}
      chmodSync(join(staging,to),0o600);
      const check=new DatabaseSync(join(staging,to),{readOnly:true});
      try{requireThat(Object.values(check.prepare('PRAGMA quick_check').get())[0]==='ok','MIGRATION_CHECK','数据库完整性检查失败。',409);}finally{check.close();}
    }
    requireThat(!existsSync(destination),'TARGET_NOT_EMPTY','目标在迁移期间已创建；未覆盖。',409);
    renameSync(staging,destination);published=true;
    return {home:destination,copied:pairs.map(([,to])=>to),sourceChanged:false,credentialsCopied:false};
  }finally{if(!published)rmSync(staging,{recursive:true,force:true});}
}
