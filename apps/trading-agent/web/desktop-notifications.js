/** Browser-session opt-in. Private account details never appear on the lock screen. */
export class DesktopNotifications {
  constructor({api,NotificationClass,timer=setTimeout,clearTimer=clearTimeout,onOpen=()=>{}}){Object.assign(this,{api,NotificationClass,timer,clearTimer,onOpen});this.enabled=false;this.seen=new Set();this.epoch=0;}
  async enable(){
    if(!this.NotificationClass)throw new Error('This browser does not support desktop notifications.');
    const permission=await this.NotificationClass.requestPermission();if(permission!=='granted')throw new Error('Desktop notification permission was not granted.');
    this.stop();this.enabled=true;const epoch=this.epoch;
    try{const rows=await this.api('notifications.list');if(!this.enabled||epoch!==this.epoch)return;this.seen=new Set(rows.map(row=>row.id));this.schedule(epoch);}catch(error){this.stop();throw error;}
  }
  schedule(epoch){this.handle=this.timer(()=>this.poll(epoch),30000);this.handle?.unref?.();}
  async poll(epoch=this.epoch){
    if(!this.enabled||epoch!==this.epoch)return;
    try{
      const rows=await this.api('notifications.list');if(!this.enabled||epoch!==this.epoch)return;
      for(const row of rows){if(!this.seen.has(row.id)&&!row.read){const notice=new this.NotificationClass('trading agent',{body:'有新的研究或订单状态通知。打开工作台查看。',tag:row.id});notice.onclick=()=>this.onOpen();}this.seen.add(row.id);}
      // Only retain bounded server history; no private payload is saved in browser storage.
      this.seen=new Set(rows.map(row=>row.id));
    }catch{this.stop();return;}
    if(this.enabled&&epoch===this.epoch)this.schedule(epoch);
  }
  stop(){this.enabled=false;this.epoch++;this.clearTimer(this.handle);}
}
