import { randomUUID } from 'node:crypto';
import { createService } from './runtime.js';
import { locales } from './locales.js';
import { errorBody, requireThat } from './errors.js';

export const name = 'trading-workbench';
export const inject = ['connection', 'dshHomePath'];
/** Mount only behind Harness Connection authentication and Host/Origin enforcement. */
export function createHttpHandler(service) {
  return async request => {
    const traceId = randomUUID();
    try {
      let data;
      if (request.method === 'GET') data = { ...service.bootstrap(), locales };
      else {
        requireThat(request.method === 'POST', 'METHOD_NOT_ALLOWED', 'HTTP方法不受支持。', 405);
        const declared = request.headers.get('content-length');
        requireThat(!declared || Number(declared) <= service.config.limits.requestBytes, 'BODY_TOO_LARGE', '请求超过大小限制。', 413);
        const body = await request.text();
        requireThat(Buffer.byteLength(body) <= service.config.limits.requestBytes, 'BODY_TOO_LARGE', '请求超过大小限制。', 413);
        const command = JSON.parse(body);
        requireThat(command && typeof command.operation === 'string' && Object.keys(command).every(key => ['operation', 'args'].includes(key)), 'INVALID_REQUEST', '请求只允许operation和args。');
        data = await service.execute(command.operation, command.args ?? {}, { actor: 'human', signal: request.signal, traceId });
      }
      return Response.json({ ok: true, data, traceId }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const failure = error instanceof SyntaxError ? { code: 'INVALID_JSON', message: '请求JSON无效。', details: {} } : errorBody(error);
      return Response.json({ ok: false, error: failure, traceId }, { status: error.status ?? (error instanceof SyntaxError ? 400 : 500), headers: { 'cache-control': 'no-store' } });
    }
  };
}
export async function apply(ctx) {
  const { service, ledger } = await createService(ctx); const handler = createHttpHandler(service);
  const shutdown = new AbortController(); const active = new Set(); let timer, pendingTick;
  ctx.effect(() => () => { shutdown.abort(); clearTimeout(timer); }, 'trading-workbench: stop scheduling');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/trading-workbench', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => {
    const combined = new Request(request, { signal: AbortSignal.any([request.signal, shutdown.signal]) });
    const pending = handler(combined); active.add(pending); pending.finally(() => active.delete(pending)); return pending;
  } }), 'trading-workbench: authenticated HTTP API');
  const schedule = () => {
    if (shutdown.signal.aborted) return;
    timer = setTimeout(() => {
      pendingTick = service.tick(shutdown.signal).catch(error => { if (!shutdown.signal.aborted) service.store.append({ operation: 'scheduler.tick', status: 'ERROR', error: errorBody(error) }); }).finally(schedule);
    }, service.config.scheduler.pollMs); timer.unref?.();
  };
  if (service.config.scheduler.enabled) schedule();
  ctx.effect(() => async () => { shutdown.abort(); clearTimeout(timer); await Promise.allSettled([...active, ...(pendingTick ? [pendingTick] : [])]); service.close(); ledger.close(); }, 'trading-workbench: settle operations and close storage');
}
