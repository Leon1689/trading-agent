import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createPiRunner } from '../pi-runtime.js';

const KEY = 'FIXTURE_KEY_NEVER_SEND_TO_LOGS';
const model = { id: 'research', provider: 'fixture', api: 'openai-completions', name: 'Offline fixture', input: ['text', 'image'], baseUrl: 'https://unused.invalid', contextWindow: 8192, maxTokens: 4096, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config = { enabled: true, provider: 'fixture', model: 'research', apiKeyEnv: 'TEST_PI_KEY', timeoutMs: 1000, maxToolCalls: 4, maxModelCalls: 4, maxTokens: 256, maxMessages: 100 };
const usage = () => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason, timestamp: Date.now() });
const toolCall = (id = 'call-1', value = 2) => ({ type: 'toolCall', id, name: 'calculate', arguments: { value } });

function modelsWith(handler, selected = model) {
  const calls = [];
  return { calls, getModel: (provider, id) => provider === selected?.provider && id === selected?.id ? selected : undefined,
    streamSimple: (activeModel, context, options) => {
      calls.push({ model: activeModel, context: structuredClone(context), options });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          const result = handler(calls.length, context, options, stream);
          if (result === null) return;
          if (result.stopReason === 'error' || result.stopReason === 'aborted') stream.push({ type: 'error', reason: result.stopReason, error: result });
          else { stream.push({ type: 'start', partial: { ...result, content: [] } }); stream.push({ type: 'done', reason: result.stopReason, message: result }); }
          stream.end(result);
        } catch (error) {
          const result = { ...assistant([], 'error'), errorMessage: error.message };
          stream.push({ type: 'error', reason: 'error', error: result }); stream.end(result);
        }
      });
      return stream;
    } };
}

const calculate = execute => ({ name: 'calculate', description: 'Multiply supplied values deterministically', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false }, execute });
const runner = (models, overrides = {}) => createPiRunner({ ...config, ...overrides }, { env: { TEST_PI_KEY: KEY }, models });

test('Actual Pi Agent executes a schema-validated tool and preserves complete context across model calls', async () => {
  const models = modelsWith(count => count === 1 ? assistant([toolCall()], 'toolUse') : assistant([{ type: 'text', text: 'The deterministic result is 4.' }]));
  const events = [], history = [{ role: 'user', content: 'Earlier evidence', timestamp: 1 }, assistant([{ type: 'text', text: 'Earlier answer' }])];
  const result = await runner(models)({ messages: history, message: 'Calculate', tools: [calculate(async (id, args) => ({ content: [{ type: 'text', text: String(args.value * 2) }], details: { value: args.value * 2 } }))], onEvent: event => events.push(event) });
  assert.equal(result.answer, 'The deterministic result is 4.'); assert.equal(result.usage.modelCalls, 2); assert.equal(result.usage.executedToolCalls, 1); assert.equal(result.usage.totalTokens, 30);
  assert.ok(result.messages.some(m => m.role === 'toolResult' && m.content[0].text === '4'));
  assert.ok(result.messages.some(m => m.role === 'user' && m.content === 'Earlier evidence'));
  assert.equal(history.length, 2);
  assert.ok(events.some(e => e.type === 'tool_execution_start')); assert.ok(events.some(e => e.type === 'tool_execution_end')); assert.ok(events.some(e => e.type === 'message_end'));
  assert.equal(models.calls[0].options.maxTokens, 256); assert.equal(models.calls[0].options.apiKey, KEY); assert.equal(models.calls[0].options.maxRetries, 0);
  assert.ok(!JSON.stringify(events).includes(KEY));
});

test('Disabled, missing-key and unknown-model configurations report UNCONFIGURED without model calls', async () => {
  const disabled = createPiRunner({ enabled: false }, { env: {} }); assert.equal(disabled.supportsImages, false);
  await assert.rejects(disabled({ message: 'Hi' }), error => error.code === 'UNCONFIGURED' && error.name === 'PiRuntimeError');
  const models = modelsWith(() => assistant([]));
  await assert.rejects(createPiRunner(config, { env: {}, models })({ message: 'Hi' }), error => error.code === 'UNCONFIGURED');
  const unknown = runner(models, { model: 'unknown' }); assert.equal(unknown.supportsImages, false);
  await assert.rejects(unknown({ message: 'Hi' }), error => error.code === 'UNCONFIGURED'); assert.equal(models.calls.length, 0);
});

test('Full history exceeding the limit is rejected, never silently sliced', async () => {
  const models = modelsWith(() => assistant([])), messages = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `Evidence ${index}`, timestamp: index }));
  await assert.rejects(runner(models, { maxMessages: 5 })({ messages, message: 'Next' }), error => error.code === 'CONTEXT_LIMIT');
  assert.equal(messages.length, 5); assert.equal(models.calls.length, 0);
});

test('Tool-call budget blocks later calls in the same batch while retaining matching tool results', async () => {
  const models = modelsWith(() => assistant([toolCall('one'), toolCall('two')], 'toolUse')); let executions = 0;
  await assert.rejects(runner(models, { maxToolCalls: 1 })({ message: 'Compute', tools: [calculate(async () => { executions++; return { content: [{ type: 'text', text: '4' }], details: {} }; })] }), error => {
    assert.equal(error.code, 'TOOL_CALL_LIMIT'); assert.equal(error.usage.executedToolCalls, 1);
    const results = error.messages.filter(m => m.role === 'toolResult'); assert.equal(results.length, 2); assert.equal(results[1].isError, true); return true;
  });
  assert.equal(executions, 1); assert.equal(models.calls.length, 1);
});

test('Model-call budget stops a tool loop before sending another provider request', async () => {
  const models = modelsWith(() => assistant([toolCall()], 'toolUse'));
  await assert.rejects(runner(models, { maxModelCalls: 1 })({ message: 'Compute', tools: [calculate(async () => ({ content: [{ type: 'text', text: '4' }], details: {} }))] }), error => error.code === 'MODEL_CALL_LIMIT' && error.usage.modelCalls === 1);
  assert.equal(models.calls.length, 1);
});

test('Tool failures become safe error results and model-visible successful tool data is redacted', async () => {
  const models = modelsWith(count => count === 1 ? assistant([toolCall()], 'toolUse') : assistant([{ type: 'text', text: 'Tool could not complete.' }]));
  const result = await runner(models)({ message: 'Compute', tools: [calculate(async () => { throw Object.assign(new Error(`private server diagnostic ${KEY}`), { code: 'UPSTREAM_ERROR' }); })] });
  assert.ok(result.messages.some(m => m.role === 'toolResult' && m.isError)); assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes('private server diagnostic'));
  const successful = modelsWith(count => count === 1 ? assistant([toolCall()], 'toolUse') : assistant([{ type: 'text', text: 'Done.' }]));
  const out = await runner(successful)({ message: 'Compute', tools: [calculate(async () => ({ content: [{ type: 'text', text: `value ${KEY}` }], details: { apiKey: KEY, value: 4 } }))] });
  assert.ok(!JSON.stringify(out).includes(KEY)); assert.equal(out.messages.find(m => m.role === 'toolResult').details.apiKey, '[REDACTED]');
});

test('Scoped service error envelopes preserve safe codes without leaking their diagnostic messages', async () => {
  const models = modelsWith(count => count === 1 ? assistant([toolCall()], 'toolUse') : assistant([{ type: 'text', text: 'Data is not configured.' }]));
  const result = await runner(models)({ message: 'Compute', tools: [calculate(async () => ({ content: [{ type: 'text', text: 'private details' }], details: { error: { code: 'UNCONFIGURED', message: `private ${KEY}` } }, isError: true }))] });
  const failure = result.messages.find(m => m.role === 'toolResult'); assert.equal(failure.details.code, 'UNCONFIGURED');
  assert.equal(failure.isError, true); assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes(KEY));
});

test('Provider error messages and trace events never contain credential or transport diagnostics', async () => {
  const models = modelsWith(() => ({ ...assistant([], 'error'), errorMessage: `Authorization ${KEY} at private-upstream.local` })), events = [];
  await assert.rejects(runner(models)({ message: 'Research', onEvent: event => events.push(event) }), error => {
    assert.equal(error.code, 'PROVIDER_ERROR'); assert.ok(!JSON.stringify(error.messages).includes(KEY)); assert.ok(!JSON.stringify(error.messages).includes('private-upstream.local')); return true;
  });
  assert.ok(!JSON.stringify(events).includes(KEY));
});

test('Turn timeout aborts an unresponsive provider and returns a settled error transcript', async () => {
  let observedSignal;
  const models = modelsWith((count, context, options) => { observedSignal = options.signal; return null; });
  const started = Date.now();
  await assert.rejects(runner(models, { timeoutMs: 25 })({ message: 'Research' }), error => error.code === 'TIMEOUT' && Array.isArray(error.messages));
  assert.ok(Date.now() - started < 500); assert.equal(observedSignal.aborted, true);
});

test('Caller cancellation stops a running tool and preserves its error result for continuation', async () => {
  const controller = new AbortController(); let signalSeen;
  const models = modelsWith(() => assistant([toolCall()], 'toolUse'));
  const promise = runner(models)({ message: 'Compute', signal: controller.signal, tools: [calculate(async (id, args, signal) => { signalSeen = signal; controller.abort(); return new Promise(() => {}); })] });
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'CANCELLED'); assert.ok(error.messages.some(m => m.role === 'toolResult' && m.isError)); return true;
  });
  assert.equal(signalSeen.aborted, true);
});

test('Failed durable trace callback stops the turn before a provider request', async () => {
  const models = modelsWith(() => assistant([]));
  await assert.rejects(runner(models)({ message: 'Research', onEvent: () => { throw new Error('database unavailable'); } }), error => error.code === 'AUDIT_FAILURE');
  assert.equal(models.calls.length, 0);
});

test('Images are inline bytes with verified MIME and supported model modality', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4kAAAAASUVORK5CYII=';
  const models = modelsWith(() => assistant([{ type: 'text', text: 'Image received.' }]));
  const run = runner(models); assert.equal(run.supportsImages, true);
  await run({ message: 'Read attached image', attachments: [{ mimeType: 'image/png', dataBase64: png }] });
  const user = models.calls[0].context.messages.findLast(m => m.role === 'user'); assert.equal(user.content[1].data, png);
  await assert.rejects(run({ message: 'Image', attachments: [{ mimeType: 'image/jpeg', dataBase64: png }] }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(run({ message: 'Image', attachments: [{ mimeType: 'image/png', url: 'file:///private/test.png' }] }), error => error.code === 'INVALID_INPUT');
  const textModels = modelsWith(() => assistant([]), { ...model, input: ['text'] }); const textRun = runner(textModels); assert.equal(textRun.supportsImages, false);
  await assert.rejects(textRun({ message: 'Image', attachments: [{ mimeType: 'image/png', dataBase64: png }] }), error => error.code === 'UNSUPPORTED_INPUT');
});

test('Research runtime rejects execution confirmation tools before any model request', async () => {
  const models = modelsWith(() => assistant([]));
  await assert.rejects(runner(models)({ message: 'Research', tools: [{ ...calculate(async () => ({})), name: 'orders_confirm' }] }), error => error.code === 'CAPABILITY_DENIED');
  assert.equal(models.calls.length, 0);
});
