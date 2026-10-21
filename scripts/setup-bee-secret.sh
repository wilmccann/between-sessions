#!/usr/bin/env bash
# Creates a dedicated Bee CLI login for the collector Lambda and stores it in
# AWS Secrets Manager. Run it yourself: it never prints the token, and the
# temporary local copy is deleted on exit.
#
#   AWS_PROFILE=agent-toolkit scripts/setup-bee-secret.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-agent-toolkit}"
REGION="${AWS_REGION:-us-east-1}"
NAME="${BEE_SECRET_NAME:-between-sessions/bee-cli-config}"

dir="$(mktemp -d)"
payload="$dir.json"
trap 'rm -rf "$dir" "$payload"' EXIT
chmod 700 "$dir"

echo "1/3 Logging in to Bee with a file-based store (approve it in the Bee app)..."
BEE_FORCE_FILE_STORE=1 BEE_CONFIG_DIR="$dir" bee login
BEE_FORCE_FILE_STORE=1 BEE_CONFIG_DIR="$dir" bee me --json > /dev/null
echo "    The login works."

# The Lambda writes these files back into its own BEE_CONFIG_DIR, so the
# secret is {relative path: base64 content}.
node -e '
  const fs = require("node:fs"), path = require("node:path");
  const root = process.argv[1], out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p).toString("base64");
  } };
  walk(root);
  if (!Object.keys(out).length) { console.error("No files in the Bee config dir"); process.exit(1); }
  fs.writeFileSync(process.argv[2], JSON.stringify(out), { mode: 0o600 });
' "$dir" "$payload"

echo "2/3 Saving to Secrets Manager as $NAME in $REGION (profile $PROFILE)..."
if aws secretsmanager describe-secret --profile "$PROFILE" --region "$REGION" --secret-id "$NAME" > /dev/null 2>&1; then
  aws secretsmanager put-secret-value --profile "$PROFILE" --region "$REGION" \
    --secret-id "$NAME" --secret-string "file://$payload" > /dev/null
else
  aws secretsmanager create-secret --profile "$PROFILE" --region "$REGION" --name "$NAME" \
    --description "Bee CLI file store for the Between Sessions collector Lambda" \
    --secret-string "file://$payload" > /dev/null
fi

echo "3/3 Done. The local copy is deleted."
