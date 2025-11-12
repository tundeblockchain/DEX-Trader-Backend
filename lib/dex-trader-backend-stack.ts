import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class DexTraderBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    // DynamoDB Table (Order Book)
    const orderBookTable = new dynamodb.Table(this, 'DEXOrderBook', {
      partitionKey: { name: 'symbol', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Add GSI for querying orders by owner
    orderBookTable.addGlobalSecondaryIndex({
      indexName: 'OwnerIndex',
      partitionKey: { name: 'owner', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
    });

    // DynamoDB Table (Trades)
    const tradesTable = new dynamodb.Table(this, 'DEXTrades', {
      partitionKey: { name: 'symbol', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tradeId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    tradesTable.addGlobalSecondaryIndex({
      indexName: 'TradesByOwnerIndex',
      partitionKey: { name: 'owner', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tradeId', type: dynamodb.AttributeType.STRING },
    });

    tradesTable.addGlobalSecondaryIndex({
      indexName: 'TradesBySymbolTimestampIndex',
      partitionKey: { name: 'symbol', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'matchedAt', type: dynamodb.AttributeType.STRING },
    });

    // DynamoDB Table (WebSocket Connections)
    const connectionsTable = new dynamodb.Table(this, 'DEXConnections', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // SQS for asynchronous trade events
    const tradeEventsQueue = new sqs.Queue(this, 'DEXTradeEventsQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    // SNS for notifications
    const notificationEmail = this.node.tryGetContext('notificationEmail');
    if (!notificationEmail) {
      throw new Error('Environment variable NOTIFICATION_EMAIL must be set');
    }
    
    const notificationsTopic = new sns.Topic(this, 'DEXNotificationsTopic');
    notificationsTopic.addSubscription(
      new subscriptions.EmailSubscription(notificationEmail)
    );

    const settlementContext = this.node.tryGetContext('settlement');
    if (!settlementContext) {
      throw new Error('Context value "settlement" must be provided');
    }

    const {
      avaxRpcUrl,
      contractAddress,
      matcherSignerKeySecretArn,
      opposingWalletAddressParamName,
      matcherConfirmations,
      adminPrivateKeySecretArn,
      adminAddressParamName,
      adminConfirmations,
    } = settlementContext;

    if (!avaxRpcUrl || !contractAddress) {
      throw new Error('Context "settlement" must include avaxRpcUrl and contractAddress');
    }

    if (!matcherSignerKeySecretArn || !opposingWalletAddressParamName) {
      throw new Error('Context "settlement" must include matcherSignerKeySecretArn and opposingWalletAddressParamName');
    }

    if (!adminPrivateKeySecretArn || !adminAddressParamName) {
      throw new Error('Context "settlement" must include adminPrivateKeySecretArn and adminAddressParamName');
    }

    const matcherSignerKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'MatcherSignerKeySecret',
      matcherSignerKeySecretArn,
    );

    const opposingWalletAddressParam = ssm.StringParameter.fromStringParameterName(
      this,
      'OpposingWalletAddressParam',
      opposingWalletAddressParamName,
    );

    const adminAddressParam = ssm.StringParameter.fromStringParameterName(
      this,
      'AdminAddressParam',
      adminAddressParamName,
    );

    const adminPrivateKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'AdminPrivateKeySecret',
      adminPrivateKeySecretArn,
    );

    // Lambda for managing WebSocket connections
    const connectLambda = new lambda.Function(this, 'ConnectHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/connect'),
      environment: { CONNECTIONS_TABLE: connectionsTable.tableName },
    });
    connectionsTable.grantWriteData(connectLambda);

    // Lambda for disconnecting WebSocket connections
    const disconnectLambda = new lambda.Function(this, 'DisconnectHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/disconnect'),
      environment: { CONNECTIONS_TABLE: connectionsTable.tableName },
    });
    connectionsTable.grantWriteData(disconnectLambda);

    // --- WebSocket API ---
    const websocketApi = new apigatewayv2.WebSocketApi(this, 'DEXTradingWebSocketApi', {
      connectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('ConnectIntegration', connectLambda) },
      disconnectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('DisconnectIntegration', disconnectLambda) },
    });

    const stage = new apigatewayv2.WebSocketStage(this, 'DevStage', {
      webSocketApi: websocketApi,
      stageName: 'dev',
      autoDeploy: true,
    });

    // Get the WebSocket API management endpoint URL (for ApiGatewayManagementApiClient)
    // Convert wss:// to https:// for the management API endpoint
    const websocketEndpoint = cdk.Fn.join('', [
      'https://',
      websocketApi.apiId,
      '.execute-api.',
      this.region,
      '.amazonaws.com/',
      stage.stageName,
    ]);

    // Matcher Lambda (core order matching)
    const matcherLambda = new lambda.Function(this, 'DEXMatcherLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/matcher'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERBOOK_TABLE: orderBookTable.tableName,
        TRADE_QUEUE_URL: tradeEventsQueue.queueUrl,
        CONNECTIONS_TABLE: connectionsTable.tableName,
        WEBSOCKET_ENDPOINT: websocketEndpoint,
        TRADES_TABLE: tradesTable.tableName,
        AVAX_RPC_URL: avaxRpcUrl,
        SETTLEMENT_CONTRACT_ADDRESS: contractAddress,
        SETTLEMENT_SIGNER_KEY: matcherSignerKeySecret.secretValue.unsafeUnwrap(),
        OPPOSING_WALLET_ADDRESS: opposingWalletAddressParam.stringValue,
        SETTLEMENT_CONFIRMATIONS: (matcherConfirmations ?? 1).toString(),
      },
    });

    orderBookTable.grantReadWriteData(matcherLambda);
    tradeEventsQueue.grantSendMessages(matcherLambda);
    connectionsTable.grantReadData(matcherLambda);
    tradesTable.grantReadWriteData(matcherLambda);

    // Grant matcher Lambda permission to manage WebSocket connections
    matcherLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${websocketApi.apiId}/${stage.stageName}/*/*`],
      })
    );

    // Add default route for matcher after it's created
    websocketApi.addRoute('$default', {
      integration: new integrations.WebSocketLambdaIntegration('DefaultIntegration', matcherLambda),
    });

    // Event Processor Lambda (consumes SQS → SNS)
    const eventProcessorLambda = new lambda.Function(this, 'DEXEventProcessorLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/eventProcessor'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        NOTIFICATIONS_TOPIC_ARN: notificationsTopic.topicArn,
        CONNECTIONS_TABLE: connectionsTable.tableName,
        WEBSOCKET_ENDPOINT: websocketEndpoint,
      },
    });

    tradeEventsQueue.grantConsumeMessages(eventProcessorLambda);
    notificationsTopic.grantPublish(eventProcessorLambda);
    connectionsTable.grantReadData(eventProcessorLambda);

    // Grant eventProcessor Lambda permission to manage WebSocket connections
    eventProcessorLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${websocketApi.apiId}/${stage.stageName}/*/*`],
      })
    );

    // Allow Lambda to poll SQS
    eventProcessorLambda.addEventSourceMapping('DEXTradeQueueEventSource', {
      eventSourceArn: tradeEventsQueue.queueArn,
      batchSize: 10,
    });

    // Binance Price Feed Lambda
    const binanceBaseUrl =
      this.node.tryGetContext('binanceBaseUrl') ?? 'https://api.binance.com/api/v3';
    const binanceSymbolOverridesContext =
      this.node.tryGetContext('binanceSymbolOverrides');
    const binanceSymbolOverrides =
      typeof binanceSymbolOverridesContext === 'string'
        ? JSON.parse(binanceSymbolOverridesContext)
        : binanceSymbolOverridesContext ?? {};

    const priceFeedLambda = new lambda.Function(this, 'DEXPriceFeedLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/priceFeed', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'npm install',
              'npm prune --omit=dev',
              'cp -R . /asset-output',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(10),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        WEBSOCKET_ENDPOINT: websocketEndpoint,
        BINANCE_BASE_URL: binanceBaseUrl,
        BINANCE_SYMBOL_MAP: JSON.stringify(binanceSymbolOverrides),
      },
    });

    connectionsTable.grantReadData(priceFeedLambda);
    priceFeedLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${websocketApi.apiId}/${stage.stageName}/*/*`],
      })
    );

    const priceFeedRefreshSecondsInput =
      Number(this.node.tryGetContext('priceFeedRefreshIntervalSeconds')) || 60;
    const priceFeedRefreshMinutes = Math.max(
      Math.ceil(priceFeedRefreshSecondsInput / 60),
      1
    );

    new events.Rule(this, 'DEXPriceFeedScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(priceFeedRefreshMinutes)),
      targets: [new targets.LambdaFunction(priceFeedLambda)],
    });

    const getLatestPricesLambda = new lambda.Function(this, 'DEXGetLatestPricesLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getLatestPrices', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'npm install',
              'npm prune --omit=dev',
              'cp -R . /asset-output',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(10),
      environment: {
        BINANCE_BASE_URL: binanceBaseUrl,
        BINANCE_SYMBOL_MAP: JSON.stringify(binanceSymbolOverrides),
      },
    });

    // Order Management Lambdas
    // Lambda to get orders by symbol
    const getOrdersBySymbolLambda = new lambda.Function(this, 'GetOrdersBySymbolLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getOrdersBySymbol'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERBOOK_TABLE: orderBookTable.tableName,
      },
    });
    orderBookTable.grantReadData(getOrdersBySymbolLambda);

    // Lambda to get orders by owner
    const getOrdersByOwnerLambda = new lambda.Function(this, 'GetOrdersByOwnerLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getOrdersByOwner'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERBOOK_TABLE: orderBookTable.tableName,
        OWNER_INDEX_NAME: 'OwnerIndex',
      },
    });
    orderBookTable.grantReadData(getOrdersByOwnerLambda);

    // Lambda to get open orders by owner
    const getOpenOrdersByOwnerLambda = new lambda.Function(this, 'GetOpenOrdersByOwnerLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getOpenOrdersByOwner'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERBOOK_TABLE: orderBookTable.tableName,
        OWNER_INDEX_NAME: 'OwnerIndex',
      },
    });
    orderBookTable.grantReadData(getOpenOrdersByOwnerLambda);

    // Lambda to get trades by owner
    const getTradesByOwnerLambda = new lambda.Function(this, 'GetTradesByOwnerLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getTradesByOwner'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        TRADES_TABLE: tradesTable.tableName,
        TRADES_OWNER_INDEX: 'TradesByOwnerIndex',
      },
    });
    tradesTable.grantReadData(getTradesByOwnerLambda);

    // Lambda to get recent trades by symbol
    const getRecentTradesBySymbolLambda = new lambda.Function(this, 'GetRecentTradesBySymbolLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getRecentTradesBySymbol'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        TRADES_TABLE: tradesTable.tableName,
        TRADES_SYMBOL_INDEX: 'TradesBySymbolTimestampIndex',
      },
    });
    tradesTable.grantReadData(getRecentTradesBySymbolLambda);

    const getCandlesticksLambda = new lambda.Function(this, 'GetCandlesticksLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/getCandlesticks'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        BINANCE_BASE_URL: binanceBaseUrl,
        BINANCE_SYMBOL_MAP: JSON.stringify(binanceSymbolOverrides),
      },
    });

    // REST API (HTTP API) for order management
    const httpApi = new apigatewayv2.HttpApi(this, 'DEXOrderManagementApi', {
      description: 'REST API for DEX order management',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const httpStage = new apigatewayv2.HttpStage(this, 'DEXOrderManagementApiDevStage', {
      httpApi,
      stageName: 'dev',
      autoDeploy: true,
    });

    // Add routes for order management
    httpApi.addRoutes({
      path: '/orders/symbol/{symbol}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetOrdersBySymbolIntegration', getOrdersBySymbolLambda),
    });

    httpApi.addRoutes({
      path: '/orders/owner/{owner}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetOrdersByOwnerIntegration', getOrdersByOwnerLambda),
    });

    httpApi.addRoutes({
      path: '/orders/owner/open/{owner}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetOpenOrdersByOwnerIntegration', getOpenOrdersByOwnerLambda),
    });

    httpApi.addRoutes({
      path: '/trades/owner/{owner}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetTradesByOwnerIntegration', getTradesByOwnerLambda),
    });

    httpApi.addRoutes({
      path: '/trades/symbol/{symbol}/recent',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetRecentTradesBySymbolIntegration', getRecentTradesBySymbolLambda),
    });

    httpApi.addRoutes({
      path: '/charts/candles/{symbol}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetCandlesticksIntegration', getCandlesticksLambda),
    });

    httpApi.addRoutes({
      path: '/prices/latest',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetLatestPricesIntegration', getLatestPricesLambda),
    });

    const assetAdminLambda = new lambda.Function(this, 'DEXAssetAdminLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/assetAdmin', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'npm install',
              'npm prune --omit=dev',
              'cp -R . /asset-output',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(10),
      environment: {
        AVAX_RPC_URL: avaxRpcUrl,
        SETTLEMENT_CONTRACT_ADDRESS: contractAddress,
        SETTLEMENT_ADMIN_PRIVATE_KEY: adminPrivateKeySecret.secretValue.unsafeUnwrap(),
        SETTLEMENT_ADMIN_ADDRESS: adminAddressParam.stringValue,
        SETTLEMENT_ADMIN_CONFIRMATIONS: (adminConfirmations ?? 1).toString(),
      },
    });

    httpApi.addRoutes({
      path: '/admin/assets',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('AssetAdminIntegration', assetAdminLambda),
    });

    const generateMockDataLambda = new lambda.Function(this, 'DEXGenerateMockDataLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/generateMockData', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'npm install',
              'npm prune --omit=dev',
              'cp -R . /asset-output',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ORDERBOOK_TABLE: orderBookTable.tableName,
        TRADES_TABLE: tradesTable.tableName,
        BINANCE_BASE_URL: binanceBaseUrl,
        BINANCE_SYMBOL_MAP: JSON.stringify(binanceSymbolOverrides),
      },
    });

    orderBookTable.grantReadWriteData(generateMockDataLambda);
    tradesTable.grantReadWriteData(generateMockDataLambda);

    httpApi.addRoutes({
      path: '/mock/orders',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('GenerateMockOrdersIntegration', generateMockDataLambda),
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: stage.url,
      description: 'WebSocket API URL',
    });

    new cdk.CfnOutput(this, 'RestApiUrl', {
      value: httpStage.url!,
      description: 'REST API URL for order management',
    });
  }
}
