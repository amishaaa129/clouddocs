
#!/usr/bin/env bash

# CloudDocs deployment script
# Existing AWS resources are reused.
# Do not use this script to create a fresh AWS environment.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BACKEND_DIR="$ROOT/backend"
LAMBDA_DIR="$ROOT/lambda"

FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-doc-processor}"
LAMBDA_HANDLER="index.handler"
LAMBDA_RUNTIME="nodejs26.x"
LAMBDA_TIMEOUT=30

USERS_TABLE="${USERS_TABLE:-DocUsers}"
DOCS_TABLE="${DOCS_TABLE:-Documents}"

for cmd in aws node npm zip pm2; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: Required command not found: $cmd"
    exit 1
  }
done

[[ -f "$BACKEND_DIR/server.js" ]] || {
  echo "ERROR: backend/server.js not found"
  exit 1
}

[[ -f "$LAMBDA_DIR/index.mjs" ]] || {
  echo "ERROR: lambda/index.mjs not found"
  exit 1
}

: "${AWS_REGION:=ap-southeast-2}"
export AWS_REGION
export AWS_DEFAULT_REGION="$AWS_REGION"

: "${S3_BUCKET:?Set S3_BUCKET}"
: "${SQS_QUEUE_URL:?Set SQS_QUEUE_URL}"
: "${JWT_SECRET:?Set JWT_SECRET}"

echo "=================================="
echo "CloudDocs Deployment"
echo "=================================="

echo "AWS Region: $AWS_REGION"
echo "S3 Bucket: $S3_BUCKET"
echo "Lambda: $FUNCTION_NAME"

ACCOUNT_ID="$(aws sts get-caller-identity \
  --query Account --output text)"

QUEUE_ARN="$(aws sqs get-queue-attributes \
  --queue-url "$SQS_QUEUE_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

# Verify existing resources.

aws s3api head-bucket \
  --bucket "$S3_BUCKET"

aws dynamodb describe-table \
  --table-name "$USERS_TABLE" >/dev/null

aws dynamodb describe-table \
  --table-name "$DOCS_TABLE" >/dev/null

aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" >/dev/null

# Preserve existing backend environment.

ENV_FILE="$BACKEND_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then

  cat > "$ENV_FILE" <<ENV
PORT=3000
AWS_REGION=$AWS_REGION
S3_BUCKET=$S3_BUCKET
USERS_TABLE=$USERS_TABLE
DOCS_TABLE=$DOCS_TABLE
SQS_QUEUE_URL=$SQS_QUEUE_URL
JWT_SECRET=$JWT_SECRET
ENV

  chmod 600 "$ENV_FILE"

else

  echo "Existing .env preserved."

fi

# Package Lambda ES module.

TMP_DIR="$(mktemp -d)"

trap 'rm -rf "$TMP_DIR"' EXIT

cp "$LAMBDA_DIR/index.mjs" "$TMP_DIR/index.mjs"

(
  cd "$TMP_DIR"
  zip -q lambda.zip index.mjs
)

# Deploy Lambda code.

echo "Updating Lambda code..."

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$TMP_DIR/lambda.zip" \
  >/dev/null

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME"

# Configure Lambda.

echo "Updating Lambda configuration..."

aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --runtime "$LAMBDA_RUNTIME" \
  --handler "$LAMBDA_HANDLER" \
  --timeout "$LAMBDA_TIMEOUT" \
  --environment "Variables={DOCS_TABLE=$DOCS_TABLE}" \
  >/dev/null

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME"

# Find existing SQS mapping.

MAPPING_UUID="$(aws lambda list-event-source-mappings \
  --function-name "$FUNCTION_NAME" \
  --query "EventSourceMappings[?EventSourceArn=='$QUEUE_ARN'].UUID | [0]" \
  --output text)"

if [[ "$MAPPING_UUID" == "None" || -z "$MAPPING_UUID" ]]; then

  echo "ERROR: Existing SQS event source mapping not found."
  exit 1

fi

# Enable existing mapping if needed.

MAPPING_STATE="$(aws lambda list-event-source-mappings \
  --function-name "$FUNCTION_NAME" \
  --query "EventSourceMappings[?UUID=='$MAPPING_UUID'].State | [0]" \
  --output text)"

if [[ "$MAPPING_STATE" != "Enabled" ]]; then

  echo "Enabling SQS trigger..."

  aws lambda update-event-source-mapping \
    --uuid "$MAPPING_UUID" \
    --enabled >/dev/null

fi

# Wait for enabled state.

for attempt in {1..30}; do

  MAPPING_STATE="$(aws lambda list-event-source-mappings \
    --function-name "$FUNCTION_NAME" \
    --query "EventSourceMappings[?UUID=='$MAPPING_UUID'].State | [0]" \
    --output text)"

  [[ "$MAPPING_STATE" == "Enabled" ]] && break

  sleep 2

done

if [[ "$MAPPING_STATE" != "Enabled" ]]; then
  echo "ERROR: SQS mapping did not become enabled."
  exit 1
fi

# Install backend dependencies.

echo "Installing backend dependencies..."

cd "$BACKEND_DIR"

npm install --omit=dev --no-audit --no-fund

# Start or restart backend.

if pm2 describe clouddocs >/dev/null 2>&1; then

  pm2 restart clouddocs --update-env

else

  pm2 start server.js --name clouddocs

fi

# Keep EC2 worker stopped to prevent competing SQS consumers.

if pm2 describe clouddocs-worker >/dev/null 2>&1; then

  pm2 stop clouddocs-worker

fi

pm2 save

echo
echo "=================================="
echo "CloudDocs deployment completed"
echo "=================================="

echo "AWS Account: $ACCOUNT_ID"
echo "AWS Region: $AWS_REGION"
echo "Lambda: $FUNCTION_NAME"
echo "SQS Mapping: $MAPPING_UUID"
echo "SQS State: $MAPPING_STATE"
echo "EC2 Worker: Stopped"
echo "Backend: Running"

echo
echo "CloudWatch log group:"
echo "/aws/lambda/$FUNCTION_NAME"
