import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

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
    const notificationEmail = process.env.NOTIFICATION_EMAIL;
    if (!notificationEmail) {
      throw new Error('Environment variable NOTIFICATION_EMAIL must be set');
    }
    const notificationsTopic = new sns.Topic(this, 'DEXNotificationsTopic');
    notificationsTopic.addSubscription(
      new subscriptions.EmailSubscription(process.env.NOTIFICATION_EMAIL || '')
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

    // Matcher Lambda (core order matching)
    const matcherLambda = new lambda.Function(this, 'DEXMatcherLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/matcher'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERBOOK_TABLE: orderBookTable.tableName,
        TRADE_QUEUE_URL: tradeEventsQueue.queueUrl,
      },
    });

    orderBookTable.grantReadWriteData(matcherLambda);
    tradeEventsQueue.grantSendMessages(matcherLambda);
    connectionsTable.grantReadData(matcherLambda);

    // Event Processor Lambda (consumes SQS → SNS)
    const eventProcessorLambda = new lambda.Function(this, 'DEXEventProcessorLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/eventProcessor'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        NOTIFICATIONS_TOPIC_ARN: notificationsTopic.topicArn,
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
    });

    tradeEventsQueue.grantConsumeMessages(eventProcessorLambda);
    notificationsTopic.grantPublish(eventProcessorLambda);
    connectionsTable.grantReadData(eventProcessorLambda);

    // Allow Lambda to poll SQS
    eventProcessorLambda.addEventSourceMapping('DEXTradeQueueEventSource', {
      eventSourceArn: tradeEventsQueue.queueArn,
      batchSize: 10,
    });

    // --- WebSocket API ---
    const websocketApi = new apigatewayv2.WebSocketApi(this, 'DEXTradingWebSocketApi', {
      connectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('ConnectIntegration', connectLambda) },
      disconnectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('DisconnectIntegration', disconnectLambda) },
      defaultRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('DefaultIntegration', matcherLambda) },
    });

    const stage = new apigatewayv2.WebSocketStage(this, 'DevStage', {
      webSocketApi: websocketApi,
      stageName: 'dev',
      autoDeploy: true,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: stage.url,
    });
  }
}
