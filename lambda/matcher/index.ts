import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const tableName = process.env.ORDERBOOK_TABLE!;
const tradeQueueUrl = process.env.TRADE_QUEUE_URL!;
const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT!;

const createMgmtClient = () =>
  new ApiGatewayManagementApiClient({
    endpoint: websocketEndpoint,
  });

const sendToConnection = async (connectionId: string, payload: any) => {
  if (!connectionId) {
    console.error("Missing connectionId; cannot send WebSocket message.");
    return;
  }

  const mgmt = createMgmtClient();
  try {
    await mgmt.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      })
    );
  } catch (err: any) {
    console.error("Error sending message to WebSocket connection:", err);
    if (err.statusCode === 410) {
      console.warn(`Connection ${connectionId} is gone.`);
    }
  }
};

export const handler = async (event: any) => {
  try {
    const { connectionId } = event.requestContext;
    let order;

    try {
      order = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      console.log("Received order payload:", order);
    } catch (err) {
      console.error("Bad JSON:", err);
      await sendToConnection(connectionId, {
        status: "ERROR",
        message: "Invalid order format",
      });
      return { statusCode: 400, body: "Invalid order format" };
    }

    // Validate required fields
    if (!order.symbol || !order.price || !order.qty || !order.owner) {
      const missing = [
        !order.symbol && "symbol",
        !order.price && "price",
        !order.qty && "qty",
        !order.owner && "owner",
      ].filter(Boolean);

      const message = `Missing required fields: ${missing.join(", ")}`;
      await sendToConnection(connectionId, {
        status: "ERROR",
        message,
      });

      return { statusCode: 400, body: JSON.stringify({ error: message }) };
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
      await sendToConnection(connectionId, {
        status: "ERROR",
        message: "Failed to store order",
      });
      return { statusCode: 500, body: JSON.stringify({ error: "Failed to store order" }) };
    }

    // Process order logic (simplified)
    const matched = Math.random() > 0.5; // logic for demo

    // Notify client of receipt
    await sendToConnection(connectionId, {
      status: "Order received",
      order: { ...order, orderId, timestamp },
    });

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
        await sendToConnection(connectionId, {
          status: "ERROR",
          message: "Failed to process trade",
        });
        // Return error but don't throw
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to process trade" }) };
      }
    }

    await sendToConnection(connectionId, {
      status: "Order stored",
      order: { ...order, orderId, timestamp },
      matched,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Order Created Successfully",
        orderId: orderId,
        order: { ...order, orderId, timestamp },
      }),
    };
  } catch (err: any) {
    console.error("Unexpected error in matcher handler:", err);
    const connectionId = event?.requestContext?.connectionId;
    await sendToConnection(connectionId, {
      status: "ERROR",
      message: "Internal server error",
    });
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Internal server error", message: err.message }) 
    };
  }
};
