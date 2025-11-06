#!/bin/bash

# Script to check CodeStar Connection status and help set up GitHub webhook

CONNECTION_ARN="arn:aws:codeconnections:eu-west-2:667167472868:connection/39ab0280-0a40-459b-a945-48ba7b3805d3"
PIPELINE_NAME="DEXTradingPlatformPipeline"
REGION="eu-west-2"

echo "Checking CodeStar Connection status..."
echo "======================================"

# Check connection status
CONNECTION_STATUS=$(aws codestar-connections get-connection \
  --connection-arn "$CONNECTION_ARN" \
  --region "$REGION" \
  --query 'Connection.ConnectionStatus' \
  --output text 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "❌ Error: Could not retrieve connection status"
  echo "Please ensure:"
  echo "  1. AWS CLI is configured correctly"
  echo "  2. You have permissions to access CodeStar Connections"
  echo "  3. The connection ARN is correct"
  exit 1
fi

echo "Connection Status: $CONNECTION_STATUS"
echo ""

if [ "$CONNECTION_STATUS" = "AVAILABLE" ]; then
  echo "✅ Connection is available and ready to use"
  echo ""
  echo "Next steps:"
  echo "1. Ensure your pipeline is deployed:"
  echo "   cdk deploy DEXTradingPlatformPipelineStack"
  echo ""
  echo "2. Trigger the pipeline manually to create the webhook:"
  echo "   aws codepipeline start-pipeline-execution --name $PIPELINE_NAME --region $REGION"
  echo ""
  echo "3. Verify webhook in GitHub:"
  echo "   https://github.com/tundeblockchain/DEX-Trader-Backend/settings/hooks"
  echo ""
  echo "4. Test by pushing a commit to the master branch"
  
elif [ "$CONNECTION_STATUS" = "PENDING" ]; then
  echo "⚠️  Connection is pending authorization"
  echo ""
  echo "To complete the setup:"
  echo "1. Go to AWS Console → Developer Tools → Settings → Connections"
  echo "2. Find your connection and click on it"
  echo "3. Click 'Update pending connection'"
  echo "4. Complete the GitHub OAuth authorization"
  echo "5. Wait for status to change to 'Available'"
  echo ""
  echo "Or use this direct link (replace with your region if different):"
  echo "https://console.aws.amazon.com/codesuite/settings/connections?region=$REGION"
  
else
  echo "❌ Connection status: $CONNECTION_STATUS"
  echo "Please check the connection in the AWS Console"
fi

echo ""
echo "Pipeline Information:"
echo "===================="

# Check if pipeline exists
PIPELINE_EXISTS=$(aws codepipeline get-pipeline \
  --name "$PIPELINE_NAME" \
  --region "$REGION" \
  --query 'pipeline.name' \
  --output text 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$PIPELINE_EXISTS" ]; then
  echo "✅ Pipeline '$PIPELINE_NAME' exists"
  
  # Get latest execution
  LATEST_EXECUTION=$(aws codepipeline list-pipeline-executions \
    --pipeline-name "$PIPELINE_NAME" \
    --region "$REGION" \
    --max-items 1 \
    --query 'pipelineExecutionSummaries[0].status' \
    --output text 2>/dev/null)
  
  if [ -n "$LATEST_EXECUTION" ] && [ "$LATEST_EXECUTION" != "None" ]; then
    echo "Latest execution status: $LATEST_EXECUTION"
  fi
else
  echo "⚠️  Pipeline '$PIPELINE_NAME' not found"
  echo "Deploy the pipeline first:"
  echo "  cdk deploy DEXTradingPlatformPipelineStack"
fi

