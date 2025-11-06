import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const tableName = process.env.ORDERBOOK_TABLE!;
const tradeQueueUrl = process.env.TRADE_QUEUE_URL!;
const connectionsTable = process.env.CONNECTIONS_TABLE!;
const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT!;

export const handler = async (event: any) => {
  try {
    const { connectionId } = event.requestContext;
    let order;

    try {
      order = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (err) {
      console.error("Bad JSON:", err);
      return { statusCode: 400, body: "Invalid order format" };
    }

    // Validate required fields
    if (!order.symbol || !order.price || !order.qty || !order.owner) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields: symbol, price, qty, owner" }) };
    }

    // Generate order ID
    const orderId = randomUUID();
    const timestamp = new Date().toISOString();

    // Store order in DynamoDB
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            symbol: { S: order.symbol },
            orderId: { S: orderId },
            owner: { S: order.owner },
            price: { N: order.price.toString() },
            qty: { N: order.qty.toString() },
            side: { S: order.side || "BUY" }, // BUY or SELL
            status: { S: "PENDING" }, // PENDING, FILLED, CANCELLED
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp },
          },
        })
      );
    } catch (err: any) {
      console.error("Error storing order in DynamoDB:", err);
      return { statusCode: 500, body: JSON.stringify({ error: "Failed to store order" }) };
    }

    // Process order logic (simplified)
    const matched = Math.random() > 0.5; // logic for demo

    // Notify client of receipt
    try {
      const mgmt = new ApiGatewayManagementApiClient({
        endpoint: websocketEndpoint,
      });
      await mgmt.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({ 
            status: "Order received", 
            order: { ...order, orderId, timestamp } 
          })),
        })
      );
    } catch (err: any) {
      console.error("Error sending message to WebSocket connection:", err);
      // Continue processing even if WebSocket message fails
    }

    if (matched) {
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: tradeQueueUrl,
            MessageBody: JSON.stringify({
              tradeId: randomUUID(),
              orderId: orderId,
              symbol: order.symbol,
              price: order.price,
              qty: order.qty,
              owner: order.owner,
            }),
          })
        );
      } catch (err: any) {
        console.error("Error sending message to SQS:", err);
        // Return error but don't throw
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to process trade" }) };
      }
    }

    return { 
      statusCode: 200, 
      body: JSON.stringify({ 
        message: "Order Created Successfully",
        orderId: orderId,
        order: { ...order, orderId, timestamp }
      }) 
    };
  } catch (err: any) {
    console.error("Unexpected error in matcher handler:", err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Internal server error", message: err.message }) 
    };
  }
};
