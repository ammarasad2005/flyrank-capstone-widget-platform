import { z } from 'zod';

const fieldDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine((name) => name !== 'website', 'website is reserved for spam detection'),
  label: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'email', 'textarea', 'tel']),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(2000).default(250),
}).strict();

const originSchema = z.string().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value;
  } catch {
    return false;
  }
}, 'must be an HTTP(S) origin without a path');

export const allowedOriginsSchema = z.array(originSchema).max(20);

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
}).strict();

const widgetShape = {
  kind: z.enum(['signup', 'contact', 'cta']),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  fields: z.array(fieldDefinitionSchema).min(1).max(20),
  buttonText: z.string().trim().min(1).max(60),
  displayOptions: z.object({
    theme: z.enum(['light', 'dark']),
    position: z.enum(['inline', 'popover']),
  }).strict(),
  allowedOrigins: allowedOriginsSchema,
};

const widgetCreateShape = {
  ...widgetShape,
  description: widgetShape.description.default(''),
  buttonText: widgetShape.buttonText.default('Submit'),
  displayOptions: widgetShape.displayOptions.default({ theme: 'light', position: 'inline' }),
  allowedOrigins: widgetShape.allowedOrigins.default([]),
};

function refineWidget(widget, context) {
  if (widget.fields) {
    const names = widget.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', path: ['fields'], message: 'field names must be unique' });
    }
  }
  if (widget.allowedOrigins && new Set(widget.allowedOrigins).size !== widget.allowedOrigins.length) {
    context.addIssue({ code: 'custom', path: ['allowedOrigins'], message: 'origins must be unique' });
  }
}

export const widgetCreateSchema = z.object(widgetCreateShape).strict().superRefine(refineWidget);
export const widgetUpdateSchema = z.object(widgetShape).partial().strict().superRefine(refineWidget);

export function validateSubmission(fields, definitions) {
  const violations = [];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { valid: false, violations: ['fields must be a JSON object'], fields: {} };
  }

  const allowed = new Set(definitions.map((definition) => definition.name));
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) violations.push(`field "${key}" is not part of this widget`);
  }

  const clean = {};
  for (const definition of definitions) {
    const value = fields[definition.name];
    if (value === undefined || value === null || value === '') {
      if (definition.required) violations.push(`${definition.label} is required`);
      continue;
    }
    if (typeof value !== 'string') {
      violations.push(`${definition.label} must be text`);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > definition.maxLength) {
      violations.push(`${definition.label} exceeds max length ${definition.maxLength}`);
      continue;
    }
    if (definition.required && trimmed.length === 0) {
      violations.push(`${definition.label} is required`);
      continue;
    }
    if (definition.type === 'email' && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      violations.push(`${definition.label} must be a valid email address`);
      continue;
    }
    clean[definition.name] = trimmed;
  }
  return { valid: violations.length === 0, violations, fields: clean };
}
