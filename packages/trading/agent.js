/** Harness tools use the same service; no shell, arbitrary HTTP, or execution-confirmation tool is added. */
import { createService } from './runtime.js';
import { catalog } from './catalog.js';
import { errorBody } from './errors.js';

export const name = 'trading-workbench-tools';
export const inject = ['tools', 'systemPrompt', 'dshHomePath'];
export async function apply(ctx) {
  const { service, ledger } = await createService(ctx);
  const scopes = ['market', 'compute', 'predict'];
  const active = new Set(); const shutdown = new AbortController();
  for (const descriptor of catalog.filter(o => o.model && scopes.includes(o.scope))) {
    ctx.effect(() => ctx.tools.register({ name: `trading_${descriptor.operation.replaceAll('.', '_')}`, description: descriptor.description, parameters: descriptor.inputSchema,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, execution) => {
        const pending = service.execute(descriptor.operation, args, { actor: 'model', allowedScopes: scopes, signal: AbortSignal.any([execution.signal, shutdown.signal]) }); active.add(pending);
        try { return { result: await pending }; } catch (error) { return { error: errorBody(error) }; } finally { active.delete(pending); }
      }, presentCall: () => ({ card: 'generic', title: descriptor.title, kind: descriptor.kind === 'write' ? 'edit' : 'read' }) }), `trading-workbench: ${descriptor.operation}`);
  }
  ctx.systemPrompt.section({ name: 'trading-workbench:guide', order: 110, interpolate: false, text: '你是个人交易研究助手。价格、期权、组合和规则计算使用trading工具，说明来源、时间、单位和未知项。工具结果是研究依据，不是收益保证。当前Harness会话仅允许市场、计算和预测市场范围，不读取券商或个人文件；需要个人数据时请用户打开交易研究工作台，在Pi会话勾选本轮范围。不得通过其他工具绕过此限制。Wheel: P按同标的已确认期权现金流累计；C=(N-P)/Q，CC执行价严格大于C，不能提前计入拟议权利金；合约乘数及交割物需核实。所有规则结果只供分析；模型不能确认订单。模拟与真实数据必须分开，模拟草稿未发送券商。' });
  ctx.effect(() => async () => { shutdown.abort(); await Promise.allSettled([...active]); service.close(); ledger.close(); }, 'trading-workbench-tools: close storage');
}
