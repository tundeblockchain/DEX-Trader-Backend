import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const tableName = process.env.ORDERBOOK_TABLE!;
const tradeQueueUrl = process.env.TRADE_QUEUE_URL!;
const connectionsTable = process.env.CONNECTIONS_TABLE!;

export const handler = async (event: any) => {
  const { connectionId, domainName, stage } = event.requestContext;
  let order;

  try {
    order = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch (err) {
    console.error("Bad JSON:", err);
    return { statusCode: 400, body: "Invalid order format" };
  }

  // Process order logic (simplified)
  const matched = Math.random() > 0.5; // logic for demo

  // Notify client of receipt
  const mgmt = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });
  await mgmt.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify({ status: "Order received", order })),
    })
  );

  if (matched) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: tradeQueueUrl,
        MessageBody: JSON.stringify({
          tradeId: randomUUID(),
          symbol: order.symbol,
          price: order.price,
          qty: order.qty,
        }),
      })
    );
  }

  return { statusCode: 200 };
};
