/** Saved comparisons never post fills, cost basis or cash into the strategy ledger. */
import {randomUUID,createHash} from 'node:crypto';
import {requireThat} from './errors.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SCALE = 100000000n;
function decimal(value) {
  const text = String(value);
  if (!/^-?\d{1,14}(\.\d{1,8})?$/.test(text)) return null;
  const [whole,fraction=''] = text.replace(/^-/,'').split('.');
  return (text.startsWith('-') ? -1n : 1n) * (BigInt(whole)*SCALE+BigInt(fraction.padEnd(8,'0')));
}
function format(value) {
  const magnitude = value < 0n ? -value : value;
  const fraction = String(magnitude % SCALE).padStart(8,'0').replace(/0+$/,'');
  return `${value < 0n ? '-' : ''}${magnitude/SCALE}${fraction ? '.'+fraction : ''}`;
}
const side = value => ({B:'BUY',BUY:'BUY',S:'SELL',SELL:'SELL'}[String(value).toUpperCase()] ?? null);
const identity = row => ({executionId:row.executionId,accountId:row.accountId,orderRef:row.orderRef,instrumentId:row.instrumentId,side:side(row.side),quantity:row.quantity,price:row.price,commission:row.commission,netAmount:row.netAmount,currency:row.currency,asOf:row.asOf});

export class Reconciliation {
  constructor(service) { this.service=service; this.store=service.store; this.now=service.now; }
  ledger() {
    requireThat(this.service.ledger,'LEDGER_UNAVAILABLE','期权账本尚未配置。',503);
    return this.service.ledger.read();
  }
  orders(accountId) {
    // Scan the complete account history, independent of the 200-row UI limit.
    const rows=this.store.db.prepare("SELECT id FROM records WHERE kind='tradeIntent' AND json_extract(body,'$.fields.accountId')=? ORDER BY id").all(accountId);
    requireThat(rows.length<=10000,'RECONCILIATION_LIMIT','账户订单超过本地对账上限，请分批归档后核对。');
    return rows.map(({id})=>this.store.require('tradeIntent',id));
  }
  versions(rows) { return digest(rows.map(row=>[row.id,row.revision])); }
  get(id) {
    const row=this.store.require('reconciliation',id);
    const stale=this.ledger().revision!==row.ledgerRevision || this.versions(this.orders(row.accountId))!==row.orderVersions;
    return {...row,stale,ledgerUpdated:false,orderSubmissionEnabled:false};
  }
  list() {
    return this.store.list('reconciliation',{limit:this.service.config.limits.listLimit}).map(row=>{
      const {positions,executions,orderFills,bindings,...summary}=this.get(row.id); return summary;
    });
  }
  create({snapshotId,ledgerRevision,accountScopeConfirmed,bindings}) {
    const snapshot=this.store.require('snapshot',snapshotId), data=snapshot.data, ledger=this.ledger();
    requireThat(ledger.revision===ledgerRevision,'VERSION_CONFLICT','账本已改变，请重新核对映射。',409);
    requireThat(accountScopeConfirmed===true,'ACCOUNT_SCOPE_REQUIRED','账本未绑定账户；请确认所选股票属于快照账户。');
    requireThat(snapshot.immutable===true && data && typeof data.accountId==='string' && data.accountId===snapshot.accountId,'SNAPSHOT_INVALID','快照账户或固定版本无效。');
    requireThat(Array.isArray(data.positions) && data.positions.length<=10000 && (data.executions===null || Array.isArray(data.executions)&&data.executions.length<=10000),'SNAPSHOT_INVALID','快照持仓或成交结构无效。');
    requireThat(bindings.length<=1000,'INVALID_BINDINGS','一次最多映射1000个持仓。');
    const symbols=new Set(), instruments=new Set();
    for(const binding of bindings) {
      requireThat(Object.hasOwn(ledger.positions,binding.symbol) && /^[1-9]\d{0,14}$/.test(binding.instrumentId) && binding.currency==='USD','INVALID_BINDINGS','映射需要已有账本股票、conid和三位币种。');
      requireThat(!symbols.has(binding.symbol)&&!instruments.has(binding.instrumentId),'INVALID_BINDINGS','每个股票和合约只能映射一次。');
      symbols.add(binding.symbol); instruments.add(binding.instrumentId);
    }
    const positions=bindings.map(binding=>{
      const matches=data.positions.filter(row=>row.instrumentId===binding.instrumentId);
      const local=decimal(ledger.positions[binding.symbol].shares);
      const broker=matches.length===1?matches[0]:null;
      const missingKnown=matches.length===0 && data.coverage?.positionsComplete===true;
      const comparable=local!==null && (missingKnown || broker && ['STK','STOCK'].includes(broker.assetClass) && broker.currency===binding.currency);
      const quantity=comparable ? (missingKnown?0n:decimal(broker.quantity)) : null;
      return {...binding,ledgerQuantity:local===null?null:format(local),brokerQuantity:quantity===null?null:format(quantity),difference:quantity===null?null:format(quantity-local),
        status:quantity===null?'UNRESOLVED':quantity===local?'MATCH':'DIFFERENCE',
        reason:quantity!==null?(missingKnown?'ABSENT_IN_COMPLETE_POSITION_LIST':'EXACT_CONTRACT_AND_CURRENCY'):matches.length>1?'DUPLICATE_CONTRACT':'MISSING_OR_INCOMPATIBLE_POSITION'};
    });
    for(const symbol of Object.keys(ledger.positions).filter(symbol=>!symbols.has(symbol))) positions.push({symbol,status:'UNMAPPED_LEDGER',reason:'ACCOUNT_AND_CONTRACT_NOT_CONFIRMED'});
    for(const row of data.positions.filter(row=>!instruments.has(row.instrumentId))) positions.push({instrumentId:row.instrumentId,symbol:row.symbol,currency:row.currency,brokerQuantity:row.quantity,status:'UNMAPPED_BROKER',reason:['STK','STOCK'].includes(row.assetClass)?'NO_EXPLICIT_LEDGER_BINDING':'OPTION_OR_OTHER_ASSET_REQUIRES_MANUAL_REVIEW'});

    const orders=this.orders(data.accountId), refs=new Map(), groups=new Map(), executions=[];
    for(const order of orders) { const group=refs.get(order.clientOrderId)??[];group.push(order);refs.set(order.clientOrderId,group); }
    for(const row of data.executions??[]) {
      if(typeof row.executionId!=='string'||!row.executionId||row.executionId.length>160) {executions.push({...identity(row),status:'INVALID_EXECUTION_ID'});continue;}
      const group=groups.get(row.executionId)??[];group.push(row);groups.set(row.executionId,group);
    }
    const sums=new Map();
    for(const [executionId,rows] of groups) {
      const row=rows[0], item=identity(row);
      if(new Set(rows.map(x=>digest(identity(x)))).size>1) {executions.push({executionId,status:'CONFLICTING_DUPLICATES',occurrences:rows.length});continue;}
      const candidates=refs.get(row.orderRef)??[], order=candidates.length===1?candidates[0]:null;
      const quantity=decimal(row.quantity), price=decimal(row.price);
      let status;
      if(row.accountId!==data.accountId) status='ACCOUNT_MISMATCH';
      else if(!order) status=candidates.length>1?'AMBIGUOUS_ORDER_REF':'UNLINKED_ORDER_REF';
      else if(String(order.fields.conid)!==row.instrumentId||order.fields.side!==side(row.side)||order.fields.currency!==row.currency) status='IDENTITY_MISMATCH';
      else if(quantity===null||quantity<=0n||price===null||price<0n) status='INVALID_EXECUTION_AMOUNT';
      else status='LINKED';
      executions.push({...item,status,occurrences:rows.length,...(status==='LINKED'?{intentId:order.id}:{})});
      if(status==='LINKED') {
        const sum=sums.get(order.id)??{quantity:0n,commission:0n,commissionComplete:true,count:0};
        sum.quantity+=quantity;sum.count++;
        const commission=decimal(row.commission);if(commission===null)sum.commissionComplete=false;else sum.commission+=commission;
        sums.set(order.id,sum);
      }
    }
    const orderFills=orders.filter(row=>!['READY','NEEDS_INPUT','PREVIEWED','DISCARDED'].includes(row.status)).map(row=>{
      const sum=sums.get(row.id), reported=decimal(row.receipt?.filledQuantity);
      const visible=sum?.quantity??0n, requested=decimal(row.fields.quantity);
      return {intentId:row.id,clientOrderId:row.clientOrderId,brokerOrderId:row.brokerOrderId??null,symbol:row.fields.symbol,currency:row.fields.currency,
        visibleQuantity:format(visible),reportedFilledQuantity:reported===null?null:format(reported),
        knownCommission:sum?format(sum.commission):null,commissionComplete:sum?.commissionComplete??false,executionCount:sum?.count??0,
        status:requested!==null&&visible>requested?'OVERFILLED':reported===null?'REPORTED_FILL_UNKNOWN':visible===reported?'VISIBLE_QUANTITY_MATCH':visible>reported?'VISIBLE_EXCEEDS_RECEIPT':'VISIBLE_WINDOW_GAP',
        reason:'VISIBLE_EXECUTIONS_ARE_NOT_COMPLETE_HISTORY'};
    });
    const limitations=['NON_ATOMIC_BROKER_SNAPSHOT','EXECUTION_WINDOW_NOT_COMPLETE_HISTORY','NO_AUTOMATIC_LEDGER_POSTING','CASH_TAX_COST_OPTIONS_AND_CORPORATE_ACTIONS_NOT_RECONCILED'];
    if(snapshot.mode==='synthetic')limitations.push('SYNTHETIC_INPUT_NOT_ACCOUNT_EVIDENCE');
    const received=Date.parse(snapshot.receivedAt);
    if(!Number.isFinite(received)||received>this.now()||this.now()-received>300000)limitations.push('STALE_OR_UNKNOWN_SNAPSHOT_TIME');
    if(!snapshot.asOf)limitations.push('NO_ATOMIC_AS_OF_TIME');
    if(data.executions===null)limitations.push('EXECUTIONS_UNAVAILABLE');
    const report=this.store.put('reconciliation',randomUUID(),{
      schemaVersion:1,accountId:data.accountId,snapshotId,snapshotRevision:snapshot.revision,ledgerRevision,bindings,
      orderVersions:this.versions(orders),source:snapshot.source??null,inputAuthority:snapshot.inputAuthority??'UNKNOWN',receivedAt:snapshot.receivedAt??null,
      createdAt:new Date(this.now()).toISOString(),status:'REVIEW_REQUIRED',positions,executions,orderFills,limitations,missing:snapshot.missing??[],
      summary:{positionDifferences:positions.filter(x=>x.status==='DIFFERENCE').length,positionUnresolved:positions.filter(x=>!['MATCH','DIFFERENCE'].includes(x.status)).length,executionIssues:executions.filter(x=>x.status!=='LINKED').length},
      review:null,ledgerUpdated:false,orderSubmissionEnabled:false,
    },0);
    return this.get(report.id);
  }
  review({id,revision,note}) {
    const row=this.get(id);
    requireThat(row.revision===revision&&!row.stale,'REPORT_STALE','报告版本或源账本/订单已变化，请生成新报告再复核。',409);
    requireThat(note.trim().length>0&&note.length<=4000,'INVALID_NOTE','请输入1到4000字的复核意见。');
    requireThat(!row.review,'ALREADY_REVIEWED','该报告已复核；请创建新报告保留记录。',409);
    this.store.put('reconciliation',id,{...row,status:'REVIEWED',review:{note:note.trim(),at:new Date(this.now()).toISOString(),actor:'human'}},revision);
    return this.get(id);
  }
}
