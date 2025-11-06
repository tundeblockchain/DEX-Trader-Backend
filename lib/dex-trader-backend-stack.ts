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

    // REST API (HTTP API) for order management
    const httpApi = new apigatewayv2.HttpApi(this, 'DEXOrderManagementApi', {
      description: 'REST API for DEX order management',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.GET],
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
      path: '/trades/owner/{owner}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetTradesByOwnerIntegration', getTradesByOwnerLambda),
    });

    httpApi.addRoutes({
      path: '/trades/symbol/{symbol}/recent',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetRecentTradesBySymbolIntegration', getRecentTradesBySymbolLambda),
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
