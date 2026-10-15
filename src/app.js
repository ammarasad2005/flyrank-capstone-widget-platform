import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config as defaultConfig } from './config.js';
import { issueAccessToken, requireAuth } from './auth.js';
import { verifyPassword } from './passwords.js';
import { createRateLimiter } from './rate-limiter.js';
import { createGeoProviders, enrichGeo } from './geo.js';
import {
  archiveWidgetForTenant,
  createSubmissionWithNotification,
  createWidgetForTenant,
  findOwnerByEmail,
  findPublicWidget,
  findSubmissionByIdempotencyKey,
  findWidgetForTenant,
  listWidgetsForTenant,
  updateWidgetForTenant,
} from './repositories.js';
import { loginSchema, validateSubmission, widgetCreateSchema, widgetUpdateSchema } from './validation.js';

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function serializeWidget(row) {
  return {
    id: Number(row.id),
    publicId: row.public_id,
    tenantId: Number(row.tenant_id),
    kind: row.kind,
    title: row.title,
    description: row.description,
    fields: row.fields,
    buttonText: row.button_text,
    displayOptions: row.display_options,
    allowedOrigins: row.allowed_origins,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sendValidationError(res, issues) {
  return res.status(422).json({
    error: 'validation_failed',
    issues: issues.map(({ path, message }) => ({ path: Array.isArray(path) ? path.join('.') : String(path ?? ''), message })),
  });
}

function validNumericId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function applyCorsOrigin(res, origin) {
  if (!origin) return;
  res.vary('Origin');
  res.set('Access-Control-Allow-Origin', origin);
}

function isOriginAllowed(widget, origin) {
  if (!origin) return true;
  return Array.isArray(widget.allowed_origins) && widget.allowed_origins.includes(origin);
}

function checkRequestedPreflightHeaders(req) {
  const requested = (req.get('access-control-request-headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(['content-type', 'idempotency-key']);
  return requested.every((header) => allowed.has(header));
}

let assetCache = null;
async function loadWidgetAsset() {
  if (!assetCache) {
    const source = await readFile(new URL(`../public/widget.${WIDGET_ASSET_VERSION}.js`, import.meta.url), 'utf8');
    assetCache = {
      source,
      etag: `"${createHash('sha256').update(source).digest('base64url').slice(0, 24)}"`,
      length: Buffer.byteLength(source),
    };
  }
  return assetCache;
}

export function createApp({
  pool,
  appConfig = defaultConfig,
  geoProviders = createGeoProviders({ timeoutMs: appConfig.geoTimeoutMs }),
  ipLimiter = createRateLimiter({ windowMs: appConfig.rateLimitWindowMs, max: appConfig.rateLimitMax }),
  widgetLimiter = createRateLimiter({ windowMs: appConfig.rateLimitWindowMs, max: appConfig.rateLimitPerWidgetMax }),
  loginLimiter = createRateLimiter({ windowMs: appConfig.rateLimitWindowMs, max: appConfig.rateLimitMax }),
  ipResolver = (req) => req.ip,
  logger = console,
} = {}) {
  if (!pool) throw new Error('createApp requires a PostgreSQL pool');
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // Resolve the public widget before parsing JSON so even malformed/oversized cross-origin
  // requests receive CORS headers when their Origin is allowed. The POST handler reloads it
  // after parsing so widget status and field definitions are checked against current data.
  app.use(asyncHandler(async (req, res, next) => {
    if (req.path !== '/submissions' || !['POST', 'OPTIONS'].includes(req.method)) return next();
    if (req.method === 'POST') req.ipRateLimitResult = ipLimiter.consume(ipResolver(req));

    const publicId = req.query.widget_id;
    if (typeof publicId === 'string' && publicId.length <= 128) {
      const widget = await findPublicWidget(pool, publicId);
      if (widget?.status === 'active') {
        const origin = req.get('origin');
        if (!isOriginAllowed(widget, origin)) return res.status(403).json({ error: 'origin_not_allowed' });
        applyCorsOrigin(res, origin);
        req.publicWidget = widget;
      }
    }

    if (req.method === 'POST' && !req.ipRateLimitResult.allowed) {
      res.set('Retry-After', String(req.ipRateLimitResult.retryAfterSeconds));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        retryAfterSeconds: req.ipRateLimitResult.retryAfterSeconds,
      });
    }
    return next();
  }));
  app.use(express.json({ limit: appConfig.bodyLimit, strict: true }));

  const limiterResponse = (res, result) => {
    res.set('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json({ error: 'rate_limit_exceeded', retryAfterSeconds: result.retryAfterSeconds });
  };

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', asyncHandler(async (_req, res) => {
    await pool.query('SELECT 1');
    return res.json({ status: 'ready' });
  }));

  app.post('/auth/login', asyncHandler(async (req, res) => {
    const ipResult = loginLimiter.consume(ipResolver(req));
    if (!ipResult.allowed) return limiterResponse(res, ipResult);
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error.issues);

    const user = await findOwnerByEmail(pool, parsed.data.email);
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const accessToken = await issueAccessToken(user, appConfig.jwtSecret);
    return res.json({ accessToken, tokenType: 'Bearer', expiresIn: 3600 });
  }));

  const widgetRouter = express.Router();
  widgetRouter.use(requireAuth(appConfig.jwtSecret));

  widgetRouter.get('/', asyncHandler(async (req, res) => {
    const rows = await listWidgetsForTenant(pool, req.auth.tenantId);
    return res.json({ widgets: rows.map((row) => serializeWidget(row)) });
  }));

  widgetRouter.post('/', asyncHandler(async (req, res) => {
    const parsed = widgetCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error.issues);
    const row = await createWidgetForTenant(pool, req.auth.tenantId, parsed.data, randomUUID());
    return res.status(201).json({ widget: serializeWidget(row) });
  }));

  widgetRouter.get('/:id', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_widget_id' });
    const row = await findWidgetForTenant(pool, req.params.id, req.auth.tenantId);
    if (!row) return res.status(404).json({ error: 'widget_not_found' });
    return res.json({ widget: serializeWidget(row) });
  }));


  widgetRouter.patch('/:id', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_widget_id' });
    const parsed = widgetUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error.issues);
    if (!Object.keys(parsed.data).length) {
      return res.status(422).json({ error: 'validation_failed', issues: [{ path: '', message: 'at least one property is required' }] });
    }

    const currentRow = await findWidgetForTenant(pool, req.params.id, req.auth.tenantId);
    if (!currentRow) return res.status(404).json({ error: 'widget_not_found' });
    const current = serializeWidget(currentRow);
    const merged = {
      kind: current.kind,
      title: current.title,
      description: current.description,
      fields: current.fields,
      buttonText: current.buttonText,
      displayOptions: current.displayOptions,
      allowedOrigins: current.allowedOrigins,
      ...parsed.data,
    };
    const checked = widgetCreateSchema.safeParse(merged);
    if (!checked.success) return sendValidationError(res, checked.error.issues);
    const updated = await updateWidgetForTenant(pool, req.params.id, req.auth.tenantId, checked.data);
    if (!updated) return res.status(404).json({ error: 'widget_not_found' });
    return res.json({ widget: serializeWidget(updated) });
  }));

  widgetRouter.delete('/:id', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_widget_id' });
    const archived = await archiveWidgetForTenant(pool, req.params.id, req.auth.tenantId);
    if (!archived) return res.status(404).json({ error: 'widget_not_found' });
    return res.status(204).end();
  }));

  app.use('/api/widgets', widgetRouter);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return res.status(400).json({ error: 'malformed_json' });
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: 'invalid_request' });
    }
    logger.error(JSON.stringify({ event: 'request_failed', message: String(error?.message ?? error) }));
    return res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
