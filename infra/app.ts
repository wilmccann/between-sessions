// CDK app: one stack, us-east-1. Deploy with `yarn cdk deploy`.
import { App, Tags } from "aws-cdk-lib";
import { BetweenSessionsStack } from "./stack.js";

const app = new App();
new BetweenSessionsStack(app, "BetweenSessions", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  description: "Between Sessions: Bee collector, session store and remote MCP server",
});
Tags.of(app).add("project", "between-sessions");
