const logger = require('../services/logger');

/**
 * 统一 API JSON 错误响应格式
 * { ok: false, error: "消息", code: "ERROR_CODE" }
 */

function normalizeHttpStatus(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return 500;
  // 限制在标准错误状态码区间，避免异常值污染响应
  if (parsed < 400 || parsed > 599) return 500;
  return parsed;
}

// 404 处理
function notFoundHandler(req, res) {
  const isApi = req.path.startsWith('/admin/api') || req.headers.accept?.includes('json');
  if (isApi) {
    return res.status(404).json({ ok: false, error: '接口不存在', code: 'NOT_FOUND' });
  }
  res.status(404).render('error', { status: 404 });
}

// 全局错误处理
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return _next(err);
  logger.error({ err, path: req.path, method: req.method }, '请求处理错误');

  const status = normalizeHttpStatus(err.status ?? err.statusCode ?? 500);
  const isApi = req.path.startsWith('/admin/api') || req.headers.accept?.includes('json');

  if (isApi) {
    return res.status(status).json({
      ok: false,
      error: status === 500 ? '服务器内部错误' : (err.message || '请求失败'),
      code: err.code || 'INTERNAL_ERROR'
    });
  }

  const safeMessage = status === 500 ? '服务器内部错误' : (err.message || '请求失败');
  if (req.app?.get('view engine')) {
    return res.status(status).render('error', { status, message: safeMessage });
  }
  const title = `${status} · Pоrпнub`;
  const heading = status === 404 ? '页面不存在' : '服务器开小差了';
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title></head><body><h1>${heading}</h1><p>${safeMessage}</p></body></html>`;
  return res.status(status).type('html').send(body);
}

module.exports = { notFoundHandler, errorHandler };
