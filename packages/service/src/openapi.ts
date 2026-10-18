/**
 * The only module that imports hono-openapi, so an upgrade touches one file.
 * Pinned to 1.5.0 in package.json.
 */
import type { Hono } from 'hono';
import type { Env } from 'hono';
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
  type DescribeRouteOptions,
  type ResponsesWithResolver,
} from 'hono-openapi';
import type { ZodType } from 'zod';

export { describeRoute, validator };

/** JSON response entry for `describeRoute({ responses })`. */
export type ResponseEntry = ResponsesWithResolver[string];

export function jsonResponse(
  description: string,
  schema: ZodType,
  extraHeaders?: Record<string, { description: string; schema: { type: 'string' } }>,
): ResponseEntry {
  return {
    description,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    content: { 'application/json': { schema: resolver(schema) } },
  };
}

export interface SpecInfo {
  title: string;
  version: string;
  description: string;
}

/** Handler serving the generated OpenAPI 3.1 document. */
export function specHandler<E extends Env>(app: Hono<E>, info: SpecInfo) {
  return openAPIRouteHandler(app, {
    documentation: {
      openapi: '3.1.0',
      info,
      tags: [
        { name: 'postcodes', description: 'Autocomplete and lookup' },
        { name: 'ops', description: 'Health and documentation' },
      ],
    },
    // Every route declares its own 400 explicitly with the service's error shape.
    defaultValidationErrorResponse: false,
  });
}

export type RouteSpec = DescribeRouteOptions;
