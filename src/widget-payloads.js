import { z } from 'zod';

/**
 * Field names the browser bundle renders itself, so a widget definition can never inject
 * markup or a second honeypot. Mirrored by the client-side guard in public/widget.v1.js.
 */
export const RESERVED_FIELD_NAMES = Object.freeze(['website', 'id', 'password', 'action', 'method', 'type']);

const publicFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(100),
  type: z.enum(['text', 'email', 'textarea', 'tel']),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(2000),
}).strict();

export const publicConfigSchema = z.object({
  publicId: z.string().min(1).max(128),
  kind: z.enum(['signup', 'contact', 'cta']),
  version: z.number().int().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(500),
  buttonText: z.string().min(1).max(60),
  displayOptions: z.object({
    theme: z.enum(['light', 'dark']),
    position: z.enum(['inline', 'popover']),
  }).strict(),
  fields: z.array(publicFieldSchema).min(1).max(20),
  submitUrl: z.string().min(1).max(512),
}).strict();

/** Name of the versioned bundle URL. Bumping this is the cache-busting release step. */
export const WIDGET_ASSET_VERSION = 'v1';
export const WIDGET_ASSET_PATH = `/public/widget.${WIDGET_ASSET_VERSION}.js`;

export function loadableFields(fields) {
  const safe = [];
  const dropped = [];
  for (const definition of Array.isArray(fields) ? fields : []) {
    const parsed = publicFieldSchema.safeParse({
      name: definition?.name,
      label: definition?.label,
      type: definition?.type,
      required: definition?.required === true,
      maxLength: definition?.maxLength ?? 250,
    });
    if (!parsed.success || RESERVED_FIELD_NAMES.includes(parsed.data.name)) {
      dropped.push(String(definition?.name ?? 'unknown'));
      continue;
    }
    safe.push(parsed.data);
  }
  return { fields: safe.slice(0, 20), dropped };
}

/**
 * Builds the public widget configuration. The submission URL always points at our own origin,
 * and the widget's public ID comes from the database row, never from request input.
 */
export function buildPublicConfig(widget, publicBaseUrl) {
  const { fields } = loadableFields(widget.fields);
  return {
    publicId: widget.public_id,
    kind: widget.kind,
    version: Number(widget.version),
    title: widget.title,
    description: widget.description ?? '',
    buttonText: widget.button_text,
    displayOptions: widget.display_options,
    fields,
    submitUrl: `${publicBaseUrl}/submissions?widget_id=${encodeURIComponent(widget.public_id)}`,
  };
}

/** A widget is loadable only when it is active and has at least one usable, renderable field. */
export function widgetIsLoadable(widget) {
  if (!widget || widget.status !== 'active') return false;
  return loadableFields(widget.fields).fields.length > 0;
}
