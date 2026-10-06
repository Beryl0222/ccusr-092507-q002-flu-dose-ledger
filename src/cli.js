import { readFile } from "node:fs/promises";
import { validateEvent } from "./contracts.js";
import { runDayEnd } from "./dayend.js";

async function readJsonOrJsonl(path) {
  const text = (await readFile(path, "utf8")).trim();
  try {
    return JSON.parse(text);
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
}

function printValidateUsage() {
  console.error("用法: node src/cli.js validate <schema.json> <event.json>");
  console.error("     node src/cli.js <schema.json> <event.json>");
  console.error("     node src/cli.js dayend <events.jsonl> <YYYY-MM-DD>");
  process.exitCode = 2;
}

const [, , command, ...rest] = process.argv;

if (!command) {
  printValidateUsage();
} else if (command === "dayend") {
  const [eventsPath, asOf] = rest;
  if (!eventsPath || !/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? "")) {
    printValidateUsage();
  } else {
    const events = await readJsonOrJsonl(eventsPath);
    const snapshot = runDayEnd(Array.isArray(events) ? events : [events], asOf);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  }
} else {
  const [schemaPath, eventPath] = command === "validate" ? rest : [command, ...rest];
  if (!schemaPath || !eventPath) {
    printValidateUsage();
  } else {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    const issues = validateEvent(event, schema);
    if (issues.length === 0) {
      console.log("valid");
    } else {
      for (const issue of issues) console.log(`${issue.field}\t${issue.code}\t${issue.message}`);
      process.exitCode = 1;
    }
  }
}
