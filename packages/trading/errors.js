/** Expected operation failures are safe to display; upstream exception messages are not. */
export class TradingError extends Error {
  constructor(code, message, status = 400, details = {}) { super(message); this.code = code; this.status = status; this.details = details; }
}
export function requireThat(condition, code, message, status = 400, details = {}) {
  if (!condition) throw new TradingError(code, message, status, details);
}
export function errorBody(error) {
  if (error instanceof TradingError) return { code: error.code, message: error.message, details: error.details };
  if (['PiRuntimeError', 'QuantError', 'ProviderError'].includes(error?.name)) return { code: error.code, message: error.message, details: {} };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'CANCELLED', message: '操作已取消或超时；请检查结果状态后重试。', details: {} };
  return { code: 'OPERATION_FAILED', message: '操作未完成，请检查输入、服务配置及诊断记录。', details: {} };
}
