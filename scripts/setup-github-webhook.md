# GitHub Webhook Setup for CodePipeline

When using AWS CodePipeline with GitHub via CodeStar Connections, the webhook needs to be set up properly.

## Automatic Setup (Recommended)

The webhook should be created automatically when:
1. The CodeStar Connection is in "Available" status
2. The pipeline is deployed and run for the first time

## Manual Setup Steps

If the webhook is not created automatically, follow these steps:

### Option 1: Via AWS Console

1. **Verify CodeStar Connection Status:**
   - Go to AWS Console → Developer Tools → Settings → Connections
   - Find your connection (ARN: `arn:aws:codeconnections:eu-west-2:667167472868:connection/39ab0280-0a40-459b-a945-48ba7b3805d3`)
   - Ensure status is "Available" (not "Pending")
   - If "Pending", click "Update pending connection" and complete the GitHub authorization

2. **Trigger Pipeline Execution:**
   - Go to CodePipeline Console
   - Select `DEXTradingPlatformPipeline`
   - Click "Release change" to trigger a manual execution
   - This should automatically create the webhook in GitHub

3. **Verify Webhook in GitHub:**
   - Go to: https://github.com/tundeblockchain/DEX-Trader-Backend/settings/hooks
   - You should see a webhook created by AWS CodePipeline
   - The webhook URL should point to AWS CodePipeline

### Option 2: Via AWS CLI

```bash
# 1. Check connection status
aws codestar-connections get-connection \
  --connection-arn arn:aws:codeconnections:eu-west-2:667167472868:connection/39ab0280-0a40-459b-a945-48ba7b3805d3

# 2. If connection is pending, you need to complete the authorization in the AWS Console

# 3. Get the webhook URL from the pipeline
aws codepipeline get-pipeline --name DEXTradingPlatformPipeline

# 4. The webhook should be automatically created when the pipeline runs
# Trigger a pipeline execution
aws codepipeline start-pipeline-execution --name DEXTradingPlatformPipeline
```

### Option 3: Manual Webhook Creation (if automatic fails)

1. **Get the Webhook URL:**
   - After the pipeline runs once, check the pipeline details
   - The webhook URL format is: `https://webhooks.codepipeline.{region}.amazonaws.com/webhook/{webhook-id}`

2. **Create Webhook in GitHub:**
   - Go to: https://github.com/tundeblockchain/DEX-Trader-Backend/settings/hooks
   - Click "Add webhook"
   - Payload URL: Use the webhook URL from step 1
   - Content type: `application/json`
   - Secret: Leave empty (CodeStar Connections handles authentication)
   - Events: Select "Just the push event" or "Let me select individual events" and choose:
     - Push
     - Pull request (if you want PR triggers)
   - Active: ✓
   - Click "Add webhook"

## Troubleshooting

### Connection Status is "Pending"
- Go to AWS Console → Developer Tools → Settings → Connections
- Click on your connection
- Click "Update pending connection"
- Complete the GitHub OAuth authorization flow
- Wait for status to change to "Available"

### Webhook Not Created After Pipeline Run
- Ensure the connection is in "Available" status
- Check CloudWatch Logs for the pipeline execution
- Verify IAM permissions for the pipeline role
- Try manually triggering the pipeline again

### Webhook Created But Not Triggering
- Verify the webhook is active in GitHub
- Check the webhook delivery logs in GitHub
- Ensure you're pushing to the correct branch (`master`)
- Check CodePipeline execution history for errors

## Verification

After setup, test by:
1. Making a commit to the `master` branch
2. Pushing to GitHub
3. Checking CodePipeline console - a new execution should start automatically

