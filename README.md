# Between Sessions

A companion for recurring 1:1 sessions (therapy, coaching, mentoring, interview loops) built on data from a [Bee](https://docs.bee.computer/docs) wearable.

Before a session it answers "what did we cover last time, what did I notice afterwards, and what do I want to bring up?" After a session it saves what Bee captured before the summaries get rewritten, and keeps the takeaways you mark.

> Status: early scaffold for the Build, Ship, Shape: Amazon Developer Hackathon (Bee track). Not ready to use yet.

## How it uses Bee data

- **Bee CLI (`@beeai/cli`)**: a collector reads conversations, insights and daily summaries with `bee ... --json` on a schedule.
- **Versioned snapshots**: Bee rewrites conversation summaries and insights over time. Between Sessions keeps every version, so the original wording from right after a session is never lost.
- **Session matching**: each *Series* (for example "weekly therapy") has a schedule rule. The conversation that matches it becomes the session, and you can confirm or correct the match.
- **Session notes and prep briefs**: Amazon Bedrock turns the session, the insights that follow it, and your own takeaways and agenda items into a short note, then into a prep brief for the next session.
- **What it does not store**: raw utterances. It works from Bee's summaries and insights.

## Interfaces

- **Voice**: Alexa on your phone, through an Alexa skill bridge ([alexa-skill-mcp-bridge](https://github.com/KayLerch/alexa-skill-mcp-bridge)) that calls this project's MCP server.
- **Typed**: a small web app (prep brief, timeline, Ask box, Markdown export), or any MCP client such as Claude Code.

## Architecture (planned)

TypeScript on AWS, deployed with AWS CDK:

- EventBridge Scheduler and Lambda: Bee collector
- DynamoDB: versioned snapshots, sessions, notes, takeaways, agenda
- Amazon Bedrock: session notes, prep briefs, Ask
- API Gateway and Lambda: web API and a remote MCP server (Streamable HTTP)
- Cognito: sign-in for the web app
- S3 and CloudFront: the web app, and private document uploads
- Secrets Manager: the Bee token and the MCP token

## Privacy

This handles sensitive personal data. Everything runs in your own AWS account. Tokens live only in Secrets Manager or local environment files and are never committed. Bee exports (`bee-sync/`) and local snapshots are git-ignored.

## Getting started

Setup instructions will land here as the pieces are built.

## License

[MIT](LICENSE)
