// The SessionStore in DynamoDB: one on-demand table, keys PK and SK (see
// table-store.ts for the layout).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { TableStore, type Item, type Table, type WriteOp } from "./table-store.js";

class DynamoTable implements Table {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly name: string,
  ) {}

  async get(pk: string, sk: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.name, Key: { PK: pk, SK: sk } }));
    return res.Item as Item | undefined;
  }

  async put(item: Item) {
    await this.doc.send(new PutCommand({ TableName: this.name, Item: item }));
  }

  // DynamoDB allows 100 items per transaction; a larger batch (a session
  // with very many versions) is split, and only each chunk is atomic.
  async transact(ops: WriteOp[]) {
    for (let i = 0; i < ops.length; i += 100) {
      const chunk = ops.slice(i, i + 100);
      if (chunk.length === 1 && "put" in chunk[0]) {
        await this.put(chunk[0].put);
        continue;
      }
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: chunk.map((op) =>
            "put" in op
              ? { Put: { TableName: this.name, Item: op.put } }
              : { Delete: { TableName: this.name, Key: op.delete } },
          ),
        }),
      );
    }
  }

  async query(pk: string, prefix: string, { descending = false, limit }: { descending?: boolean; limit?: number } = {}) {
    const items: Item[] = [];
    let start: QueryCommandInput["ExclusiveStartKey"];
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.name,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ScanIndexForward: !descending,
          Limit: limit,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((res.Items ?? []) as Item[]));
      start = res.LastEvaluatedKey;
    } while (start && (limit === undefined || items.length < limit));
    return limit === undefined ? items : items.slice(0, limit);
  }

  async scanSk(sk: string) {
    const items: Item[] = [];
    let start: QueryCommandInput["ExclusiveStartKey"];
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.name,
          FilterExpression: "SK = :sk",
          ExpressionAttributeValues: { ":sk": sk },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((res.Items ?? []) as Item[]));
      start = res.LastEvaluatedKey;
    } while (start);
    return items;
  }
}

export const TABLE_NAME = process.env.TABLE_NAME ?? "between-sessions";

export function dynamoStore(tableName = TABLE_NAME): TableStore {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return new TableStore(new DynamoTable(doc, tableName));
}
