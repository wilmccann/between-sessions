// CDK app, us-east-1. Deploy one stack at a time:
//   corepack yarn cdk deploy BetweenSessions
//   corepack yarn cdk deploy CostGuardrails -c alertEmail=you@example.com
import { App, Tags } from "aws-cdk-lib";
import { CostGuardrailsStack } from "./guardrails.js";
import { BetweenSessionsStack } from "./stack.js";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" };

const betweenSessions = new BetweenSessionsStack(app, "BetweenSessions", {
  env,
  description: "Between Sessions: Bee collector, session store and remote MCP server",
});
Tags.of(betweenSessions).add("project", "between-sessions");

// Account-wide, so it is only built when an alert address is given; the
// address stays out of git.
const alertEmail = app.node.tryGetContext("alertEmail") as string | undefined;
if (alertEmail) {
  const guardrails = new CostGuardrailsStack(app, "CostGuardrails", {
    env,
    description: "Account-wide budgets, anomaly alerts and a Lambda kill switch",
    alertEmail,
    killPrefixes: ["between-sessions-"],
  });
  Tags.of(guardrails).add("project", "cost-guardrails");
}
