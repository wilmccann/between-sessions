// The BetweenSessions stack: a collector Lambda that runs the Bee CLI every
// 15 minutes and stores matched sessions in DynamoDB, and a remote MCP server
// (Lambda behind an HTTP API) that answers from that table.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PREFIX = "between-sessions";
const BEE_SECRET = `${PREFIX}/bee-cli-config`;
const MCP_TOKEN_SECRET = `${PREFIX}/mcp-token`;
// Bedrock notes are off unless deployed with `-c notes=true`. The collector
// may call either model; pick one with `-c bedrockModelId=<profile id>`.
const BEDROCK_MODELS = {
  "us.anthropic.claude-sonnet-5-5": "anthropic.claude-sonnet-5-5*",
  "us.amazon.nova-lite-v1:0": "amazon.nova-lite-v1:0",
};
const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-5-5";

export class BetweenSessionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const notesEnabled = String(this.node.tryGetContext("notes") ?? "false") === "true";
    const modelId = String(this.node.tryGetContext("bedrockModelId") ?? DEFAULT_MODEL_ID);
    if (!(modelId in BEDROCK_MODELS)) throw new Error(`bedrockModelId must be one of ${Object.keys(BEDROCK_MODELS).join(", ")}`);

    // Personal data: removed with the stack.
    const table = new Table(this, "Table", {
      tableName: PREFIX,
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.DEFAULT,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Created by scripts/setup-bee-secret.sh; the stack only reads and refreshes it.
    const beeSecret = Secret.fromSecretNameV2(this, "BeeCliConfig", BEE_SECRET);

    const mcpToken = new Secret(this, "McpToken", {
      secretName: MCP_TOKEN_SECRET,
      description: "Bearer token for the Between Sessions remote MCP server",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = (name: string, entry: string, props: Partial<NodejsFunctionProps>) =>
      new NodejsFunction(this, name, {
        functionName: `${PREFIX}-${name.toLowerCase()}`,
        entry: join(ROOT, entry),
        handler: "handler",
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        projectRoot: ROOT,
        depsLockFilePath: join(ROOT, "yarn.lock"),
        logGroup: new LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${PREFIX}-${name.toLowerCase()}`,
          retention: RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...props,
        bundling: { externalModules: [], minify: true, sourceMap: false, ...props.bundling },
        environment: { TABLE_NAME: table.tableName, ...props.environment },
      });

    const collector = fn("Collector", "src/aws/collector.ts", {
      description: "Runs the Bee CLI and stores matched sessions",
      memorySize: 1024,
      timeout: Duration.minutes(5),
      environment: {
        BEE_BIN: "/var/task/bee",
        BEE_FORCE_FILE_STORE: "1",
        BEE_CONFIG_DIR: "/tmp/bee-config",
        BEE_SECRET_ID: BEE_SECRET,
        HOME: "/tmp",
        BEDROCK_NOTES_ENABLED: String(notesEnabled),
        BEDROCK_MODEL_ID: modelId,
      },
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // The Bee CLI ships a prebuilt Linux arm64 binary; put it next to the handler.
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp "${inputDir}/node_modules/@beeai/cli/dist/platforms/linux-arm64/bee" "${outputDir}/bee"`,
            `chmod 755 "${outputDir}/bee"`,
          ],
        },
      },
    });
    table.grantReadWriteData(collector);
    beeSecret.grantRead(collector);
    beeSecret.grantWrite(collector);
    collector.addToRolePolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: Object.entries(BEDROCK_MODELS).flatMap(([profile, model]) => [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${profile}`,
          `arn:aws:bedrock:*::foundation-model/${model}`,
        ]),
      }),
    );

    new Schedule(this, "CollectorSchedule", {
      scheduleName: `${PREFIX}-collector`,
      description: "Collect Bee sessions every 15 minutes",
      schedule: ScheduleExpression.rate(Duration.minutes(15)),
      target: new LambdaInvoke(collector, { retryAttempts: 0 }),
      enabled: true,
    });

    const mcp = fn("Mcp", "src/aws/mcp-handler.ts", {
      description: "Remote MCP server for Between Sessions",
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { MCP_TOKEN_SECRET_ID: MCP_TOKEN_SECRET },
    });
    // Reads sessions; writes only agenda items and takeaways.
    table.grantReadWriteData(mcp);
    mcpToken.grantRead(mcp);

    const api = new HttpApi(this, "Api", {
      apiName: `${PREFIX}-mcp`,
      description: "Between Sessions remote MCP endpoint",
      createDefaultStage: false,
    });
    new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    api.addRoutes({
      path: "/mcp",
      methods: [HttpMethod.POST, HttpMethod.GET, HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("McpIntegration", mcp),
    });

    new CfnOutput(this, "McpUrl", { value: `${api.apiEndpoint}/mcp` });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "CollectorFunctionName", { value: collector.functionName });
    new CfnOutput(this, "McpFunctionName", { value: mcp.functionName });
    new CfnOutput(this, "BeeSecretName", { value: BEE_SECRET });
    new CfnOutput(this, "McpTokenSecretName", { value: MCP_TOKEN_SECRET });
  }
}
