// 事件日志读取与校验：只接受通过契约校验的事件，逐行报错、绝不静默改写。
import { readFile } from "node:fs/promises";

import { validateEvent } from "./contracts.js";

export async function loadEvents(schema, files) {
  const events = [];
  const errors = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        errors.push({ file, line: index + 1, field: "$", code: "json_parse", message: "不是合法 JSON" });
        return;
      }
      const issues = validateEvent(event, schema);
      if (issues.length > 0) {
        for (const issue of issues) errors.push({ file, line: index + 1, ...issue });
        return;
      }
      events.push(event);
    });
  }
  return { events, errors };
}
