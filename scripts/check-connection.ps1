# PowerShell script to check CodeStar Connection status and help set up GitHub webhook

$CONNECTION_ARN = "arn:aws:codeconnections:eu-west-2:667167472868:connection/39ab0280-0a40-459b-a945-48ba7b3805d3"
$PIPELINE_NAME = "DEXTradingPlatformPipeline"
$REGION = "eu-west-2"

Write-Host "Checking CodeStar Connection status..." -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

try {
    # Check connection status
    $connection = aws codestar-connections get-connection `
        --connection-arn $CONNECTION_ARN `
        --region $REGION `
        --output json 2>&1 | ConvertFrom-Json

    if ($connection.Connection.ConnectionStatus) {
        $status = $connection.Connection.ConnectionStatus
        Write-Host "Connection Status: $status" -ForegroundColor $(if ($status -eq "AVAILABLE") { "Green" } else { "Yellow" })
        Write-Host ""

        if ($status -eq "AVAILABLE") {
            Write-Host "✅ Connection is available and ready to use" -ForegroundColor Green
            Write-Host ""
            Write-Host "Next steps:" -ForegroundColor Cyan
            Write-Host "1. Ensure your pipeline is deployed:"
            Write-Host "   cdk deploy DEXTradingPlatformPipelineStack"
            Write-Host ""
            Write-Host "2. Trigger the pipeline manually to create the webhook:"
            Write-Host "   aws codepipeline start-pipeline-execution --name $PIPELINE_NAME --region $REGION"
            Write-Host ""
            Write-Host "3. Verify webhook in GitHub:"
            Write-Host "   https://github.com/tundeblockchain/DEX-Trader-Backend/settings/hooks"
            Write-Host ""
            Write-Host "4. Test by pushing a commit to the master branch"
        }
        elseif ($status -eq "PENDING") {
            Write-Host "⚠️  Connection is pending authorization" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "To complete the setup:" -ForegroundColor Cyan
            Write-Host "1. Go to AWS Console → Developer Tools → Settings → Connections"
            Write-Host "2. Find your connection and click on it"
            Write-Host "3. Click 'Update pending connection'"
            Write-Host "4. Complete the GitHub OAuth authorization"
            Write-Host "5. Wait for status to change to 'Available'"
            Write-Host ""
            Write-Host "Or use this direct link:"
            Write-Host "https://console.aws.amazon.com/codesuite/settings/connections?region=$REGION" -ForegroundColor Blue
        }
        else {
            Write-Host "❌ Connection status: $status" -ForegroundColor Red
            Write-Host "Please check the connection in the AWS Console"
        }
    }
}
catch {
    Write-Host "❌ Error: Could not retrieve connection status" -ForegroundColor Red
    Write-Host "Please ensure:" -ForegroundColor Yellow
    Write-Host "  1. AWS CLI is configured correctly"
    Write-Host "  2. You have permissions to access CodeStar Connections"
    Write-Host "  3. The connection ARN is correct"
    Write-Host ""
    Write-Host "Error details: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Pipeline Information:" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan

try {
    $pipeline = aws codepipeline get-pipeline `
        --name $PIPELINE_NAME `
        --region $REGION `
        --output json 2>&1 | ConvertFrom-Json

    if ($pipeline.pipeline.name) {
        Write-Host "✅ Pipeline '$PIPELINE_NAME' exists" -ForegroundColor Green

        # Get latest execution
        $executions = aws codepipeline list-pipeline-executions `
            --pipeline-name $PIPELINE_NAME `
            --region $REGION `
            --max-items 1 `
            --output json 2>&1 | ConvertFrom-Json

        if ($executions.pipelineExecutionSummaries -and $executions.pipelineExecutionSummaries.Count -gt 0) {
            $latestStatus = $executions.pipelineExecutionSummaries[0].status
            Write-Host "Latest execution status: $latestStatus" -ForegroundColor $(if ($latestStatus -eq "Succeeded") { "Green" } else { "Yellow" })
        }
    }
}
catch {
    Write-Host "⚠️  Pipeline '$PIPELINE_NAME' not found" -ForegroundColor Yellow
    Write-Host "Deploy the pipeline first:" -ForegroundColor Cyan
    Write-Host "  cdk deploy DEXTradingPlatformPipelineStack"
}

Write-Host ""

