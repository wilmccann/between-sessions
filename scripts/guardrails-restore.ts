// Undo the cost guardrails kill switch: remove the 0-concurrency limit from
// every function under the given prefixes (default: between-sessions-).
// Functions with a deliberate non-zero reservation are left alone.
// Needs credentials allowed to manage Lambda concurrency, for example:
//   AWS_PROFILE=aws-admin AWS_REGION=us-east-1 corepack yarn guardrails:restore [--dry-run] [prefix ...]
import {
  DeleteFunctionConcurrencyCommand,
  GetFunctionConcurrencyCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { listFunctionNames, targets } from "../src/aws/kill-switch.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prefixes = args.filter((a) => !a.startsWith("--"));
const lambda = new LambdaClient({});

const names = targets(await listFunctionNames(lambda), prefixes.length ? prefixes : ["between-sessions-"]);
let restored = 0;
for (const name of names) {
  const { ReservedConcurrentExecutions: reserved } = await lambda.send(
    new GetFunctionConcurrencyCommand({ FunctionName: name }),
  );
  if (reserved !== 0) {
    console.log(`${name}: not throttled (reserved ${reserved ?? "none"}), left alone`);
    continue;
  }
  if (!dryRun) await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: name }));
  console.log(`${name}: ${dryRun ? "would restore" : "restored"}`);
  restored++;
}
console.log(`${dryRun ? "would restore" : "restored"} ${restored} of ${names.length} function(s)`);
