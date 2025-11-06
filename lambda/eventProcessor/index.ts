import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const ddb = new DynamoDBClient({});
const sns = new SNSClient({});
const topicArn = process.env.NOTIFICATIONS_TOPIC_ARN!;
const connectionsTable = process.env.CONNECTIONS_TABLE!;
const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT!;

export const handler = async (event: any) => {
  for (const record of event.Records) {
    const trade = JSON.parse(record.body);

    const message = `Trade ${trade.tradeId || 'unknown'} (${trade.type || 'unknown'}) executed: ${trade.symbol} ${trade.qty}@${trade.price}`;

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: message,
      })
    );

    // Push to WebSocket clients
    const connections = await ddb.send(new ScanCommand({ TableName: connectionsTable }));
    const mgmt = new ApiGatewayManagementApiClient({
      endpoint: websocketEndpoint,
    });
    
    for (const item of connections.Items || []) {
      const connectionId = item.connectionId.S!;

      try {
        await mgmt.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(
              JSON.stringify({
                type: "TRADE",
                trade,
              })
            ),
          })
        );
      } catch (err) {
        // Ignore stale connections
      }
    }
  }
};
