import { parseArgs } from "node:util";

function hasExplicitTimezone(value) {
  return typeof value === "string" && (/Z$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) && !Number.isNaN(Date.parse(value));
}

function isDateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function getPath(obj, path) {
  return path.split(".").reduce((cur, key) => (cur !== null && typeof cur === "object" ? cur[key] : undefined), obj);
}

export function validateEvent(payload, schema) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [{ field: "$", code: "object_required", message: "事件必须是 JSON 对象" }];
  }
  const issues = [];
  for (const field of schema.required ?? []) {
    if (!(field in payload)) issues.push({ field, code: "required", message: "缺少必填字段" });
  }
  for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id"]) {
    if (field in payload && (typeof payload[field] !== "string" || payload[field].trim() === "")) {
      issues.push({ field, code: "non_empty_string", message: "字段必须是非空字符串" });
    }
  }
  if ("version" in payload && (!Number.isInteger(payload.version) || payload.version < 1)) {
    issues.push({ field: "version", code: "positive_integer", message: "版本必须是正整数" });
  }
  if ("occurred_at" in payload && !hasExplicitTimezone(payload.occurred_at)) {
    issues.push({ field: "occurred_at", code: "timezone_required", message: "发生时间必须包含时区" });
  }
  for (const field of ["event_type", "aggregate_type"]) {
    const allowed = schema.properties?.[field]?.enum ?? [];
    if (typeof payload[field] === "string" && allowed.length > 0 && !allowed.includes(payload[field])) {
      issues.push({ field, code: "unsupported_value", message: "字段值未在契约中登记" });
    }
  }
  const eventPayload = payload.payload;
  if ("payload" in payload && (eventPayload === null || typeof eventPayload !== "object" || Array.isArray(eventPayload))) {
    issues.push({ field: "payload", code: "object_required", message: "事件载荷必须是 JSON 对象" });
  } else if (typeof payload.event_type === "string" && eventPayload && typeof eventPayload === "object" && !Array.isArray(eventPayload)) {
    const eventType = payload.event_type;
    for (const path of schema.payload_required_by_event?.[eventType] ?? []) {
      if (getPath(eventPayload, path) === undefined) {
        issues.push({ field: `payload.${path}`, code: "required", message: "事件载荷缺少必填字段" });
      }
    }
    for (const [path, allowed] of Object.entries(schema.payload_string_enums_by_event?.[eventType] ?? {})) {
      const value = getPath(eventPayload, path);
      if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
        issues.push({ field: `payload.${path}`, code: "unsupported_value", message: "载荷字段值未在契约中登记" });
      }
    }
    for (const path of schema.payload_datetime_fields_by_event?.[eventType] ?? []) {
      const value = getPath(eventPayload, path);
      if (value !== undefined && value !== null && !hasExplicitTimezone(value)) {
        issues.push({ field: `payload.${path}`, code: "timezone_required", message: "载荷时间必须包含时区" });
      }
    }
    for (const path of schema.payload_date_fields_by_event?.[eventType] ?? []) {
      const value = getPath(eventPayload, path);
      if (value !== undefined && !isDateOnly(value)) {
        issues.push({ field: `payload.${path}`, code: "date_required", message: "载荷日期必须是 YYYY-MM-DD" });
      }
    }
    for (const path of schema.payload_integer_fields_by_event?.[eventType] ?? []) {
      const value = getPath(eventPayload, path);
      if (value !== undefined && !Number.isInteger(value)) {
        issues.push({ field: `payload.${path}`, code: "integer_required", message: "载荷字段必须是整数" });
      }
    }
    for (const path of schema.payload_boolean_fields_by_event?.[eventType] ?? []) {
      const value = getPath(eventPayload, path);
      if (value !== undefined && typeof value !== "boolean") {
        issues.push({ field: `payload.${path}`, code: "boolean_required", message: "载荷字段必须是布尔值" });
      }
    }
  }
  return issues.sort((left, right) => left.field.localeCompare(right.field) || left.code.localeCompare(right.code));
}
