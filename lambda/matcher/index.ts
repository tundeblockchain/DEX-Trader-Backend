import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { randomUUID } from "crypto";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const tableName = process.env.ORDERBOOK_TABLE!;
const tradeQueueUrl = process.env.TRADE_QUEUE_URL!;
const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT!;
const tradesTableName = process.env.TRADES_TABLE!;

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

const sendOrderMessage = async (connectionId: string, payload: Record<string, any>) =>
  sendToConnection(connectionId, {
    channel: "orders",
    ...payload,
  });

export const handler = async (event: any) => {
  try {
    const { connectionId } = event.requestContext;
    let order;

    try {
      order = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      console.log("Received order payload:", order);
    } catch (err) {
      console.error("Bad JSON:", err);
      await sendOrderMessage(connectionId, {
        type: "ORDER_ERROR",
        status: "ERROR",
        message: "Invalid order format",
      });
      return { statusCode: 400, body: "Invalid order format" };
    }

    // Validate required fields
    const orderType = typeof order.type === "string" ? order.type.toLowerCase() : undefined;

    if (
      !order.symbol ||
      !order.price ||
      !order.qty ||
      !order.owner ||
      !orderType ||
      (orderType !== "limit" && orderType !== "market")
    ) {
      const missing = [
        !order.symbol && "symbol",
        !order.price && "price",
        !order.qty && "qty",
        !order.owner && "owner",
        (!orderType || (orderType !== "limit" && orderType !== "market")) && "type (limit or market)",
      ].filter(Boolean);

      const message = `Missing required fields: ${missing.join(", ")}`;
      await sendOrderMessage(connectionId, {
        type: "ORDER_ERROR",
        status: "ERROR",
        message,
      });

      return { statusCode: 400, body: JSON.stringify({ error: message }) };
    }

    // Generate order ID
    const orderId = randomUUID();
    const timestamp = new Date().toISOString();

    // Determine match outcome
    const matched = orderType === "market" ? true : Math.random() > 0.5; // placeholder logic
    const status = matched ? "FILLED" : "PENDING";
    const matchedAt = matched ? new Date().toISOString() : undefined;
    const updatedAt = matched ? matchedAt! : timestamp;

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
            type: { S: orderType },
            status: { S: status }, // PENDING, FILLED, CANCELLED
            createdAt: { S: timestamp },
            updatedAt: { S: updatedAt },
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

    let tradePayload: Record<string, any> | undefined;

    // Notify client of receipt
    await sendOrderMessage(connectionId, {
      type: "ORDER_RECEIVED",
      status: "Order received",
      order: { ...order, orderId, timestamp },
    });

    if (matched) {
      const tradeId = randomUUID();

      try {
        await ddb.send(
          new PutItemCommand({
            TableName: tradesTableName,
            Item: {
              symbol: { S: order.symbol },
              tradeId: { S: tradeId },
              orderId: { S: orderId },
              owner: { S: order.owner },
              price: { N: order.price.toString() },
              qty: { N: order.qty.toString() },
              side: { S: order.side || "BUY" },
              type: { S: orderType },
              matchedAt: { S: matchedAt! },
              createdAt: { S: timestamp },
            },
          })
        );
      } catch (err: any) {
        console.error("Error storing trade in DynamoDB:", err);
        await sendOrderMessage(connectionId, {
          type: "ORDER_ERROR",
          status: "ERROR",
          message: "Failed to store trade",
        });
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to store trade" }) };
      }

      tradePayload = {
        tradeId,
        orderId,
        symbol: order.symbol,
        price: order.price,
        qty: order.qty,
        owner: order.owner,
        side: order.side || "BUY",
        type: orderType,
        matchedAt,
      };

      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: tradeQueueUrl,
            MessageBody: JSON.stringify({
              ...tradePayload,
            }),
          })
        );
      } catch (err: any) {
        console.error("Error sending message to SQS:", err);
        await sendOrderMessage(connectionId, {
          type: "ORDER_ERROR",
          status: "ERROR",
          message: "Failed to process trade",
        });
        // Return error but don't throw
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to process trade" }) };
      }
    }

    const responsePayload: Record<string, any> = {
      status: matched ? "Order matched" : "Order stored",
      order: { ...order, orderId, timestamp, type: orderType, status },
      matched,
    };

    if (tradePayload) {
      responsePayload.trade = tradePayload;
    }

    await sendOrderMessage(connectionId, {
      type: matched ? "ORDER_MATCHED" : "ORDER_STORED",
      ...responsePayload,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Order Created Successfully",
        orderId: orderId,
        order: { ...order, orderId, timestamp, type: orderType, status },
        matched,
        trade: tradePayload,
      }),
    };
  } catch (err: any) {
    console.error("Unexpected error in matcher handler:", err);
    const connectionId = event?.requestContext?.connectionId;
    await sendOrderMessage(connectionId ?? "", {
      type: "ORDER_ERROR",
      status: "ERROR",
      message: "Internal server error",
    });
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Internal server error", message: err.message }) 
    };
  }
};
