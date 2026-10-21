// The CostGuardrails stack: account-wide cost alerts and a kill switch. It is
// separate from BetweenSessions so it covers the whole account and outlives
// any one app. AWS has no hard spending cap, so this pairs alerts with rate
// limits set in each project's own stack:
// - a daily budget whose 100% alert triggers the kill switch,
// - a monthly budget and a Bedrock-only daily budget (email only),
// - Cost Anomaly Detection on every service, alerting as soon as it finds one,
// - a kill switch that sets registered projects' Lambda functions to 0
//   concurrency. Undo with `corepack yarn guardrails:restore`.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnAnomalyMonitor, CfnAnomalySubscription } from "aws-cdk-lib/aws-ce";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription, LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PREFIX = "cost-guardrails";

export interface CostGuardrailsProps extends StackProps {
  /** Where alerts go. Kept out of git: pass `-c alertEmail=...`. */
  alertEmail: string;
  /** Lambda function-name prefixes the kill switch may throttle. */
  killPrefixes: string[];
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  bedrockDailyLimitUsd?: number;
  anomalyThresholdUsd?: number;
}

export class CostGuardrailsStack extends Stack {
  constructor(scope: Construct, id: string, props: CostGuardrailsProps) {
    super(scope, id, props);
    const {
      alertEmail,
      killPrefixes,
      dailyLimitUsd = 5,
      monthlyLimitUsd = 50,
      bedrockDailyLimitUsd = 2,
      anomalyThresholdUsd = 3,
    } = props;
    if (!killPrefixes.length || killPrefixes.some((p) => p.length < 3)) {
      throw new Error("killPrefixes must be non-empty and each at least 3 characters");
    }

    // Two topics, so the kill switch only ever hears the daily budget's 100% alert.
    // Unencrypted on purpose: Budgets can't publish to topics using the aws/sns key.
    const alerts = new Topic(this, "Alerts", { topicName: `${PREFIX}-alerts`, displayName: "AWS cost guardrails" });
    alerts.addSubscription(new EmailSubscription(alertEmail));
    const kill = new Topic(this, "Kill", { topicName: `${PREFIX}-kill`, displayName: "AWS cost guardrails kill switch" });

    const allowPublish = (topic: Topic, service: string, sourceArn?: string) =>
      topic.addToResourcePolicy(
        new PolicyStatement({
          principals: [new ServicePrincipal(service)],
          actions: ["sns:Publish"],
          resources: [topic.topicArn],
          conditions: {
            StringEquals: { "aws:SourceAccount": this.account },
            ...(sourceArn ? { ArnLike: { "aws:SourceArn": sourceArn } } : {}),
          },
        }),
      ).policyDependable;
    const budgetsArn = `arn:${this.partition}:budgets::${this.account}:*`;
    const alertsPolicy = [
      allowPublish(alerts, "budgets.amazonaws.com", budgetsArn),
      allowPublish(alerts, "costalerts.amazonaws.com"),
    ];
    const killPolicy = allowPublish(kill, "budgets.amazonaws.com", budgetsArn);

    const email = { subscriptionType: "EMAIL", address: alertEmail };
    const actual = (threshold: number, subscribers = [email]) => ({
      notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
      subscribers,
    });
    // Gross spend: credits and refunds would otherwise hide real usage.
    const grossCost = { includeCredit: false, includeRefund: false };

    const daily = new CfnBudget(this, "DailyBudget", {
      budget: {
        budgetName: "account-daily",
        budgetType: "COST",
        timeUnit: "DAILY",
        budgetLimit: { amount: dailyLimitUsd, unit: "USD" },
        costTypes: grossCost,
      },
      notificationsWithSubscribers: [
        actual(50),
        actual(80),
        actual(100, [email, { subscriptionType: "SNS", address: kill.topicArn }]),
      ],
    });
    daily.node.addDependency(killPolicy!);

    // Daily budgets can't forecast, and forecasts need about 5 weeks of history.
    new CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "account-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: monthlyLimitUsd, unit: "USD" },
        costTypes: grossCost,
      },
      notificationsWithSubscribers: [
        actual(50),
        actual(100),
        {
          notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
          subscribers: [email],
        },
      ],
    });

    // Third-party models on Bedrock bill under their own service names
    // ("... (Amazon Bedrock Edition)"), hence CONTAINS rather than EQUALS.
    new CfnBudget(this, "BedrockDailyBudget", {
      budget: {
        budgetName: "bedrock-daily",
        budgetType: "COST",
        timeUnit: "DAILY",
        budgetLimit: { amount: bedrockDailyLimitUsd, unit: "USD" },
        metrics: ["UnblendedCost"],
        filterExpression: {
          and: [
            { dimensions: { key: "SERVICE", values: ["Bedrock"], matchOptions: ["CONTAINS"] } },
            { not: { dimensions: { key: "RECORD_TYPE", values: ["Credit", "Refund"] } } },
          ],
        },
      },
      notificationsWithSubscribers: [actual(100)],
    });

    // One AWS-services monitor per account; alerts go out as soon as an
    // anomaly is found. Absolute impact, since a percentage is undefined at $0.
    const monitor = new CfnAnomalyMonitor(this, "AnomalyMonitor", {
      monitorName: "account-services",
      monitorType: "DIMENSIONAL",
      monitorDimension: "SERVICE",
    });
    const anomalies = new CfnAnomalySubscription(this, "AnomalySubscription", {
      subscriptionName: "account-services-immediate",
      frequency: "IMMEDIATE",
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: "SNS", address: alerts.topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: [String(anomalyThresholdUsd)],
        },
      }),
    });
    for (const p of alertsPolicy) if (p) anomalies.node.addDependency(p);

    const killSwitch = new NodejsFunction(this, "KillSwitch", {
      functionName: `${PREFIX}-kill-switch`,
      description: "Throttles registered projects' Lambda functions when the daily budget is exceeded",
      entry: join(ROOT, "src/aws/kill-switch.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, "yarn.lock"),
      logGroup: new LogGroup(this, "KillSwitchLogs", {
        logGroupName: `/aws/lambda/${PREFIX}-kill-switch`,
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { externalModules: [], minify: true, sourceMap: false },
      environment: { KILL_PREFIXES: killPrefixes.join(","), ALERT_TOPIC_ARN: alerts.topicArn },
    });
    killSwitch.addToRolePolicy(new PolicyStatement({ actions: ["lambda:ListFunctions"], resources: ["*"] }));
    // It can only ever touch the registered prefixes.
    killSwitch.addToRolePolicy(
      new PolicyStatement({
        actions: ["lambda:PutFunctionConcurrency"],
        resources: killPrefixes.map((p) => `arn:${this.partition}:lambda:${this.region}:${this.account}:function:${p}*`),
      }),
    );
    alerts.grantPublish(killSwitch);
    kill.addSubscription(new LambdaSubscription(killSwitch));
  }
}
