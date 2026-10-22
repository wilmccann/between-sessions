// Lookup commands to paste into a terminal: Bee's own record for an id, and
// the table item behind a row. Your terminal's AWS profile and region apply.
export interface Lookup {
  label: string;
  command: string;
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const beeConversation = (id: string | number): Lookup => ({ label: `bee ${id}`, command: `bee conversations get ${shellQuote(String(id))} --json` });
export const beeJournal = (id: string): Lookup => ({ label: "bee", command: `bee journals get ${shellQuote(id)} --json` });
export const beeInsight = (id: string | number): Lookup => ({ label: "bee", command: `bee insights get ${shellQuote(String(id))} --json` });
const attr = (v: string) => ({ S: v });
export const dynamoGet = (table: string, key: { PK: string; SK: string }): Lookup => ({
  label: "db",
  command: `aws dynamodb get-item --table-name ${shellQuote(table)} --key ${shellQuote(JSON.stringify({ PK: attr(key.PK), SK: attr(key.SK) }))}`,
});
export const dynamoQuery = (table: string, key: { PK: string; prefix: string }): Lookup => ({
  label: "db",
  command:
    `aws dynamodb query --table-name ${shellQuote(table)} --key-condition-expression 'PK = :pk AND begins_with(SK, :sk)' ` +
    `--expression-attribute-values ${shellQuote(JSON.stringify({ ":pk": attr(key.PK), ":sk": attr(key.prefix) }))}`,
});
