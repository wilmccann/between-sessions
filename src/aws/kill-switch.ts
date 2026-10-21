// Cost guardrails kill switch. The CostGuardrails stack subscribes it to the
// kill topic, which only the daily budget's 100% alert publishes to. It sets
// every Lambda function under the registered prefixes to 0 concurrency, which
// stops scheduled runs and API work alike, then emails what it changed.
// Invoke it with {"dryRun": true} to list targets without changing anything.
import { LambdaClient, PutFunctionConcurrencyCommand, paginateListFunctions } from "@aws-sdk/client-lambda";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

export interface KillEvent {
  dryRun?: boolean;
  Records?: { Sns?: { Subject?: string } }[];
}

export interface KillDeps {
  listFunctions(): Promise<string[]>;
  throttle(name: string): Promise<void>;
  notify(subject: string, message: string): Promise<void>;
}

/** Function names under any prefix, never the kill switch itself. */
export function targets(names: string[], prefixes: string[], self?: string): string[] {
  const valid = prefixes.map((p) => p.trim()).filter((p) => p.length >= 3);
  return names.filter((n) => n !== self && valid.some((p) => n.startsWith(p))).sort();
}

export async function listFunctionNames(client: LambdaClient): Promise<string[]> {
  const names: string[] = [];
  for await (const page of paginateListFunctions({ client }, {})) {
    for (const f of page.Functions ?? []) if (f.FunctionName) names.push(f.FunctionName);
  }
  return names;
}

export function makeHandler(deps: KillDeps, prefixes: string[], self?: string) {
  return async (event: KillEvent = {}) => {
    const names = targets(await deps.listFunctions(), prefixes, self);
    const trigger = event.Records?.[0]?.Sns?.Subject ?? "direct invoke";
    if (event.dryRun) {
      console.log(`dry run (${trigger}): would throttle ${names.length} function(s): ${names.join(", ")}`);
      return { dryRun: true, functions: names };
    }

    const throttled: string[] = [];
    const failed: string[] = [];
    for (const name of names) {
      try {
        await deps.throttle(name);
        throttled.push(name);
      } catch (err) {
        console.error(`throttle failed for ${name}:`, (err as Error).message);
        failed.push(name);
      }
    }
    console.log(`kill switch (${trigger}): throttled ${throttled.length}, failed ${failed.length}`);
    await deps.notify(
      "Cost guardrails kill switch fired",
      [
        `Trigger: ${trigger}`,
        `Set to 0 concurrency: ${throttled.join(", ") || "none"}`,
        ...(failed.length ? [`Failed: ${failed.join(", ")}`] : []),
        "",
        "Undo, once the cause is fixed: corepack yarn guardrails:restore",
      ].join("\n"),
    );
    if (failed.length) throw new Error(`Could not throttle: ${failed.join(", ")}`);
    return { dryRun: false, functions: throttled };
  };
}

const lambda = new LambdaClient({});
const sns = new SNSClient({});

export const handler = makeHandler(
  {
    listFunctions: () => listFunctionNames(lambda),
    throttle: async (name) => {
      await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: 0 }));
    },
    notify: async (subject, message) => {
      await sns.send(new PublishCommand({ TopicArn: process.env.ALERT_TOPIC_ARN, Subject: subject, Message: message }));
    },
  },
  (process.env.KILL_PREFIXES ?? "").split(","),
  process.env.AWS_LAMBDA_FUNCTION_NAME,
);
