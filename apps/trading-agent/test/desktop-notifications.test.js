import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopNotifications} from '../web/desktop-notifications.js';
test('desktop notifications require explicit opt-in and omit private content',async()=>{
 const shown=[];let rows=[{id:'old'}];class Notice{static async requestPermission(){return 'granted';}constructor(title,args){shown.push({title,args});}}
 const n=new DesktopNotifications({api:async()=>rows,NotificationClass:Notice,timer:()=>1,clearTimer:()=>{}});await n.poll();assert.equal(shown.length,0);await n.enable();await n.poll();assert.equal(shown.length,0);
 rows=[{id:'new',message:'PRIVATE_ACCOUNT_VALUE'},{id:'old'}];await n.poll();assert.equal(shown.length,1);assert(!JSON.stringify(shown).includes('PRIVATE_ACCOUNT_VALUE'));await n.poll();assert.equal(shown.length,1);n.stop();
});
test('pausing desktop delivery discards an in-flight notification response',async()=>{
 let release,rows=[];class Notice{static async requestPermission(){return 'granted';}constructor(){assert.fail('delivery after pause');}}
 const n=new DesktopNotifications({api:async()=>rows,NotificationClass:Notice,timer:()=>1,clearTimer:()=>{}});await n.enable();n.api=()=>new Promise(r=>{release=r;});const pending=n.poll();n.stop();release([{id:'late'}]);await pending;
});
