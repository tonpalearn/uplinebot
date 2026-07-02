/**
 * Broadcast & Campaigns — template rendering helpers (module_key: broadcast_campaigns).
 * Source: SPEC.md §6.4, SYSTEM-DESIGN.md §4.2/§4.4.
 *
 * Supports simple {{variable}} substitution against a plain key/value map
 * (e.g. { date: "2 กรกฎาคม 2026" }) applied to an upl_broadcasts.payload jsonb value
 * before it's sent as an OutboundMessage. Substitution is deep — it walks strings
 * nested anywhere in the payload (e.g. inside a Flex `contents` tree), not just a
 * single top-level `text` field, since payload can be either a 'text' or 'flex' shape.
 */

import type { OutboundMessage } from "../types";

export type TemplateVariables = Record<string, string | number>;

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Substitutes {{key}} occurrences in a single string against `variables`. Unknown keys are left untouched. */
export function substituteVariables(input: string, variables: TemplateVariables): string {
  return input.replace(VARIABLE_PATTERN, (match, key: string) => {
    const value = variables[key];
    return value === undefined ? match : String(value);
  });
}

/** Recursively walks any JSON-ish value, substituting variables in every string leaf. */
function deepSubstitute<T>(value: T, variables: TemplateVariables): T {
  if (typeof value === "string") {
    return substituteVariables(value, variables) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepSubstitute(item, variables)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepSubstitute(v, variables);
    }
    return result as unknown as T;
  }
  return value;
}

export interface BroadcastPayloadRow {
  message_type: "text" | "flex";
  payload: Record<string, unknown>;
}

/**
 * Renders an upl_broadcasts row (message_type + payload jsonb) into an OutboundMessage,
 * substituting {{variable}} placeholders against `variables` throughout the payload.
 *
 * Expected payload shapes:
 * - message_type 'text': { text: "สวัสดี {{display_name}} วันนี้ {{date}}" }
 * - message_type 'flex': { altText: "...", contents: { ...Flex JSON with {{vars}} anywhere... } }
 */
export function renderBroadcastPayload(
  row: BroadcastPayloadRow,
  variables: TemplateVariables = {}
): OutboundMessage {
  const rendered = deepSubstitute(row.payload, variables);

  if (row.message_type === "flex") {
    return {
      type: "flex",
      altText: typeof rendered.altText === "string" ? rendered.altText : "",
      contents: (rendered.contents as Record<string, unknown>) ?? {},
    };
  }

  return {
    type: "text",
    text: typeof rendered.text === "string" ? rendered.text : "",
  };
}
