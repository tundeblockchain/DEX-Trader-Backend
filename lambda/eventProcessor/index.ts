import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const ddb = new DynamoDBClient({});
const sns = new SNSClient({});
const topicArn = process.env.NOTIFICATIONS_TOPIC_ARN!;
const connectionsTable = process.env.CONNECTIONS_TABLE!;

export const handler = async (event: any) => {
  for (const record of event.Records) {
    const trade = JSON.parse(record.body);

    // Publish to SNS
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: `Trade executed: ${trade.symbol} ${trade.qty}@${trade.price}`,
      })
    );

    // Push to WebSocket clients
    const connections = await ddb.send(new ScanCommand({ TableName: connectionsTable }));
    for (const item of connections.Items || []) {
      const connectionId = item.connectionId.S!;
      const mgmt = new ApiGatewayManagementApiClient({
        endpoint: `https://${event.requestContext?.domainName}/${event.requestContext?.stage}`,
      });

      try {
        await mgmt.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(JSON.stringify({ type: "TRADE", trade })),
          })
        );
      } catch (err) {
        // Ignore stale connections
      }
    }
  }
};
