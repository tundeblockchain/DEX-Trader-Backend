# DEX Trader Backend

AWS CDK project for a decentralized exchange (DEX) trading platform backend with WebSocket support.

## Prerequisites

- Node.js and npm installed
- AWS CLI configured
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- GitHub repository with CodeStar Connection set up

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure context variables in `cdk.json`:
   - `githubOwner`: Your GitHub username/organization
   - `githubRepo`: Repository name
   - `githubBranch`: Branch to monitor (default: `master`)
   - `connectionURN`: AWS CodeStar Connection ARN
   - `notificationEmail`: Email for SNS notifications

3. Deploy the pipeline stack:
```bash
cdk deploy DEXTradingPlatformPipelineStack
```

## GitHub Webhook Setup

After deploying the pipeline, you need to ensure the GitHub webhook is created:

### Quick Check
Run the connection check script:
```powershell
# Windows
.\scripts\check-connection.ps1

# Linux/Mac
./scripts/check-connection.sh
```

### Manual Setup

1. **Verify CodeStar Connection Status:**
   - Go to AWS Console → Developer Tools → Settings → Connections
   - Ensure your connection status is "Available" (not "Pending")
   - If pending, click "Update pending connection" and complete GitHub authorization

2. **Trigger Pipeline to Create Webhook:**
   ```bash
   aws codepipeline start-pipeline-execution --name DEXTradingPlatformPipeline --region eu-west-2
   ```

3. **Verify Webhook in GitHub:**
   - Go to: `https://github.com/{your-owner}/{your-repo}/settings/hooks`
   - You should see a webhook created by AWS CodePipeline

For detailed instructions, see [scripts/setup-github-webhook.md](scripts/setup-github-webhook.md)

## Useful Commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
