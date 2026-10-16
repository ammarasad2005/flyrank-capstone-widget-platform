import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
  findSubmissionForTenant,
  findWidgetForTenant,
  listSubmissionsForTenant,
  listWidgetsForTenant,
  statisticsForTenant,
  updateWidgetForTenant,
} from './repositories.js';
import { loginSchema, validateSubmission, widgetCreateSchema, widgetUpdateSchema } from './validation.js';
import {
  WIDGET_ASSET_PATH,
  WIDGET_ASSET_VERSION,
  buildPublicConfig,
  publicConfigSchema,
  widgetIsLoadable,
} from './widget-payloads.js';

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const CONFIG_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function embedSnippet(publicId, baseUrl) {
  return `<script src="${baseUrl}/public/widget.js?id=${encodeURIComponent(publicId)}" async></script>`;
}

function serializeWidget(row, baseUrl) {
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
    embed: {
      snippet: embedSnippet(row.public_id, baseUrl),
      scriptUrl: `${baseUrl}/public/widget.js?id=${encodeURIComponent(row.public_id)}`,
      configUrl: `${baseUrl}/widgets/${encodeURIComponent(row.public_id)}/config`,
    },
  };
}

function serializeSubmission(row) {
  return {
    id: Number(row.id),
    widgetId: Number(row.widget_id),
    fields: row.fields,
    geo: {
      country: row.geo_country,
      city: row.geo_city,
      provider: row.geo_provider,
    },
    createdAt: row.created_at,
  };
}

function parseIntParam(value, { name, min, max, fallback }) {
  if (value === undefined) return { value: fallback };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { error: { path: name, message: `${name} must be an integer between ${min} and ${max}` } };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { error: { path: name, message: `${name} must be an integer between ${min} and ${max}` } };
  }
  return { value: parsed };
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

  // The owner dashboard is a static page served from the API origin so the admin UI stays
  // same-origin with the authenticated API. The customer-facing test page is deliberately
  // served from a different port by `npm run demo:page`.
  app.use('/demo', express.static(fileURLToPath(new URL('../demo', import.meta.url)), {
    index: false,
    dotfiles: 'ignore',
    etag: true,
    maxAge: 0,
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));

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
    return res.json({ widgets: rows.map((row) => serializeWidget(row, appConfig.publicBaseUrl)) });
  }));

  widgetRouter.post('/', asyncHandler(async (req, res) => {
    const parsed = widgetCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error.issues);
    const row = await createWidgetForTenant(pool, req.auth.tenantId, parsed.data, randomUUID());
    return res.status(201).json({ widget: serializeWidget(row, appConfig.publicBaseUrl) });
  }));

  widgetRouter.get('/:id', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_widget_id' });
    const row = await findWidgetForTenant(pool, req.params.id, req.auth.tenantId);
    if (!row) return res.status(404).json({ error: 'widget_not_found' });
    return res.json({ widget: serializeWidget(row, appConfig.publicBaseUrl) });
  }));

  widgetRouter.get('/:id/embed', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_widget_id' });
    const row = await findWidgetForTenant(pool, req.params.id, req.auth.tenantId);
    if (!row) return res.status(404).json({ error: 'widget_not_found' });
    const embed = serializeWidget(row, appConfig.publicBaseUrl).embed;
    return res.json({
      widgetId: Number(row.id),
      publicId: row.public_id,
      status: row.status,
      version: row.version,
      ...embed,
      notes: [
        'Paste the snippet into the customer page. The script loads the widget configuration and renders the form.',
        'The page origin must appear in the widget allowedOrigins list or submissions are rejected with 403.',
      ],
    });
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
    const current = serializeWidget(currentRow, appConfig.publicBaseUrl);
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
    return res.json({ widget: serializeWidget(updated, appConfig.publicBaseUrl) });
  }));

  widgetRouter.delete('/:id', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_widget_id' });
    const archived = await archiveWidgetForTenant(pool, req.params.id, req.auth.tenantId);
    if (!archived) return res.status(404).json({ error: 'widget_not_found' });
    return res.status(204).end();
  }));

  app.use('/api/widgets', widgetRouter);

  const ownerSubmissionsRouter = express.Router();
  ownerSubmissionsRouter.use(requireAuth(appConfig.jwtSecret));

  ownerSubmissionsRouter.get('/', asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query.limit, { name: 'limit', min: 1, max: 100, fallback: 20 });
    if (limit.error) return sendValidationError(res, [limit.error]);
    const offset = parseIntParam(req.query.offset, { name: 'offset', min: 0, max: 1_000_000, fallback: 0 });
    if (offset.error) return sendValidationError(res, [offset.error]);

    let widgetId = null;
    if (req.query.widgetId !== undefined) {
      if (!validNumericId(req.query.widgetId)) {
        return sendValidationError(res, [{ path: 'widgetId', message: 'widgetId must be a positive integer' }]);
      }
      widgetId = Number(req.query.widgetId);
    }

    const { rows, total } = await listSubmissionsForTenant(pool, req.auth.tenantId, {
      limit: limit.value,
      offset: offset.value,
      widgetId,
    });
    return res.json({
      submissions: rows.map(serializeSubmission),
      pagination: {
        limit: limit.value,
        offset: offset.value,
        total,
        hasMore: offset.value + rows.length < total,
      },
    });
  }));

  ownerSubmissionsRouter.get('/:id', asyncHandler(async (req, res) => {
    if (!validNumericId(req.params.id)) return res.status(400).json({ error: 'invalid_submission_id' });
    const row = await findSubmissionForTenant(pool, req.params.id, req.auth.tenantId);
    if (!row) return res.status(404).json({ error: 'submission_not_found' });
    return res.json({ submission: serializeSubmission(row) });
  }));

  app.use('/api/submissions', ownerSubmissionsRouter);

  app.get('/api/stats', requireAuth(appConfig.jwtSecret), asyncHandler(async (req, res) => {
    const days = parseIntParam(req.query.days, { name: 'days', min: 1, max: 365, fallback: 30 });
    if (days.error) return sendValidationError(res, [days.error]);
    let widgetId = null;
    if (req.query.widgetId !== undefined) {
      if (!validNumericId(req.query.widgetId)) {
        return sendValidationError(res, [{ path: 'widgetId', message: 'widgetId must be a positive integer' }]);
      }
      widgetId = Number(req.query.widgetId);
    }

    const stats = await statisticsForTenant(pool, req.auth.tenantId, { days: days.value, widgetId });
    return res.json({
      windowDays: stats.windowDays,
      totals: {
        submissions: Number(stats.totals.submissions ?? 0),
        countries: Number(stats.totals.countries ?? 0),
        withoutGeo: Number(stats.totals.without_geo ?? 0),
        lastSubmissionAt: stats.totals.last_submission_at,
      },
      byDay: stats.timeline.map((row) => ({ date: row.date, count: Number(row.count) })),
      byWidget: stats.perWidget.map((row) => ({
        widgetId: Number(row.id),
        publicId: row.public_id,
        title: row.title,
        status: row.status,
        count: Number(row.count),
        lastSubmissionAt: row.last_submission_at,
      })),
      byCountry: stats.countries.map((row) => ({ country: row.country, count: Number(row.count) })),
      generatedAt: new Date().toISOString(),
    });
  }));

  // Public widget delivery: configuration (short cache, ETag revalidation) and the
  // versioned browser bundle (long, immutable cache; a new release changes the URL).
  app.get('/widgets/:publicId/config', asyncHandler(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const publicId = req.params.publicId;
    if (!publicId || publicId.length > 128) {
      return res.status(404).json({ error: 'widget_not_found' });
    }
    const widget = await findPublicWidget(pool, publicId);
    if (!widgetIsLoadable(widget)) return res.status(404).json({ error: 'widget_not_found' });

    res.set('Cache-Control', CONFIG_CACHE_CONTROL);
    res.set('ETag', `W/"cfg-${widget.public_id}-${widget.version}"`);
    if (req.fresh) return res.status(304).end();

    const payload = publicConfigSchema.safeParse(buildPublicConfig(widget, appConfig.publicBaseUrl));
    if (!payload.success) {
      logger.error(JSON.stringify({ event: 'widget_config_invalid', publicId: widget.public_id }));
      return res.status(500).json({ error: 'internal_server_error' });
    }
    return res.json(payload.data);
  }));

  app.get('/public/:file', asyncHandler(async (req, res) => {
    const file = req.params.file;
    if (!/^widget(\.[A-Za-z0-9_-]{1,16})?\.js$/.test(file)) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Vary', 'Accept-Encoding');

    // Anything other than the current version is a bundle an old snippet still points at.
    if (file !== 'widget.js' && file !== `widget.${WIDGET_ASSET_VERSION}.js`) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(410).json({ error: 'stale_widget_bundle', current: WIDGET_ASSET_PATH });
    }

    const asset = await loadWidgetAsset();
    const isStableAlias = file === 'widget.js';

    res.set('Content-Type', 'application/javascript; charset=utf-8');
    // The versioned URL can be cached forever; the stable alias the snippet uses must be
    // re-checked regularly so a release actually reaches already-embedded pages.
    // (It is served directly rather than redirected: cross-origin script redirects are
    // blocked by Chromium's Opaque Response Blocking.)
    res.set('Cache-Control', isStableAlias ? 'public, max-age=300' : ASSET_CACHE_CONTROL);
    res.set('X-Widget-Bundle', WIDGET_ASSET_VERSION);
    res.set('ETag', asset.etag);
    res.set('Content-Length', String(asset.length));
    if (req.fresh) return res.status(304).end();
    return res.send(asset.source);
  }));

  app.options('/submissions', asyncHandler(async (req, res) => {
    const widgetId = req.query.widget_id;
    if (typeof widgetId !== 'string' || widgetId.length > 128) {
      return res.status(400).json({ error: 'valid_widget_id_required' });
    }
    const widget = req.publicWidget ?? await findPublicWidget(pool, widgetId);
    if (!widget || widget.status !== 'active') return res.status(404).json({ error: 'widget_not_found' });
    const origin = req.get('origin');
    if (!isOriginAllowed(widget, origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    const requestedMethod = req.get('access-control-request-method');
    if (requestedMethod && requestedMethod.toUpperCase() !== 'POST') {
      return res.status(403).json({ error: 'preflight_method_not_allowed' });
    }
    if (!checkRequestedPreflightHeaders(req)) return res.status(403).json({ error: 'preflight_header_not_allowed' });

    applyCorsOrigin(res, origin);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.set('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }));

  app.post('/submissions', asyncHandler(async (req, res) => {
    const widgetId = req.query.widget_id;
    if (typeof widgetId !== 'string' || widgetId.length > 128) {
      return res.status(400).json({ error: 'valid_widget_id_required' });
    }
    const widget = await findPublicWidget(pool, widgetId);
    if (!widget || widget.status !== 'active') return res.status(404).json({ error: 'widget_not_found' });

    const origin = req.get('origin');
    if (!isOriginAllowed(widget, origin)) {
      res.removeHeader('Access-Control-Allow-Origin');
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    applyCorsOrigin(res, origin);

    const widgetResultForRate = widgetLimiter.consume(String(widget.id));
    if (!widgetResultForRate.allowed) return limiterResponse(res, widgetResultForRate);

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(422).json({ error: 'validation_failed', issues: [{ path: '', message: 'request body must be a JSON object' }] });
    }
    if (body.website) {
      return res.status(202).json({ received: true });
    }
    const bodyKeys = Object.keys(body);
    if (bodyKeys.some((key) => !['fields', 'website'].includes(key))) {
      return res.status(422).json({ error: 'validation_failed', issues: [{ path: '', message: 'only fields and website are accepted' }] });
    }
    if (!Object.hasOwn(body, 'fields')) {
      return res.status(422).json({ error: 'validation_failed', issues: [{ path: 'fields', message: 'fields are required' }] });
    }
    const validated = validateSubmission(body.fields, widget.fields);
    if (!validated.valid) {
      return res.status(422).json({ error: 'validation_failed', issues: validated.violations.map((message) => ({ path: 'fields', message })) });
    }

    const idempotencyHeader = req.get('idempotency-key');
    if (idempotencyHeader !== undefined && (idempotencyHeader.length < 1 || idempotencyHeader.length > 128 || /[\r\n]/.test(idempotencyHeader))) {
      return res.status(400).json({ error: 'invalid_idempotency_key' });
    }
    const idempotencyKey = idempotencyHeader ?? null;
    if (idempotencyKey !== null) {
      const existing = await findSubmissionByIdempotencyKey(pool, widget.id, idempotencyKey);
      if (existing) {
        return res.status(200).json({ received: true, submissionId: Number(existing.id), reused: true });
      }
    }
    const geo = await enrichGeo(req.ip, geoProviders);
    const saved = await createSubmissionWithNotification(pool, {
      widget,
      fields: validated.fields,
      idempotencyKey,
      geo,
    });

    return res.status(saved.reused ? 200 : 201).json({
      received: true,
      submissionId: saved.id,
      ...(saved.reused ? { reused: true } : {}),
    });
  }));

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
