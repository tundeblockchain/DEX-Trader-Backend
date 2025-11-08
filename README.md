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

## Binance Price Feed Streaming

The backend includes a scheduled Lambda (`DEXPriceFeedLambda`) that polls the Binance public REST API and rebroadcasts the latest pricing updates over the project WebSocket. Configure the following CDK context values in `cdk.json` (or via `cdk deploy --context`):

- `binanceBaseUrl` (optional): Override the Binance API base URL. Defaults to `https://api.binance.com/api/v3`.
- `binanceSymbolOverrides` (optional): JSON object mapping tickers to Binance symbols or objects `{ "symbol": "BTCUSDT", "supply": 21000000 }`. Use this when Binance updates ticker names or you add new pairs.
- `priceFeedRefreshIntervalSeconds` (optional): Override the polling cadence (minimum 60 seconds due to EventBridge rate-expression limits).

The Lambda emits WebSocket messages of the form:

```json
{
  "type": "PRICE",
  "channel": "prices",
  "symbol": "BTC",
  "price": 69123.45,
  "decimals": 2,
  "updatedAt": "2025-11-06T13:08:00.000Z",
  "source": "BINANCE",
  "marketData": {
    "bid": 69123.1,
    "ask": 69124.0,
    "spread": 0.9,
    "open24h": 68200.0,
    "high24h": 69999.0,
    "low24h": 67777.0,
    "close24h": 69123.45,
    "volume24h": 12345.67,
    "change24h": 1.35,
    "marketCap": 1350000000000
  }
}
```

Your React client can subscribe to the existing WebSocket endpoint and filter on `channel` to target specific updates.

### WebSocket Channels

All WebSocket payloads now include a `channel` field:

- `prices`: Real-time price messages from `DEXPriceFeedLambda`.
- `trades`: Trade execution notices emitted by `DEXEventProcessorLambda`.
- `orders`: Order acknowledgements, status changes, and errors from the matcher Lambda.

### REST Endpoints

The HTTP API exposes additional endpoints, including:

- `GET /prices/latest` — Returns the latest Binance prices (and 24h metrics) for all configured symbols.
- `GET /orders/symbol/{symbol}`, `GET /orders/owner/{owner}`, `GET /orders/owner/open/{owner}` — Order queries.
- `GET /trades/owner/{owner}`, `GET /trades/symbol/{symbol}/recent` — Trade queries.

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
