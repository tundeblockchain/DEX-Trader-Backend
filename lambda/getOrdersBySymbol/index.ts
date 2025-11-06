import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const tableName = process.env.ORDERBOOK_TABLE!;

// Helper function to convert DynamoDB item to plain object
const unmarshallItem = (item: any) => {
  const result: any = {};
  for (const key in item) {
    const value = item[key];
    if (value.S) result[key] = value.S;
    else if (value.N) result[key] = value.N;
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
    else if (value.SS) result[key] = value.SS;
    else if (value.NS) result[key] = value.NS;
  }
  return result;
};

export const handler = async (event: any) => {
  try {
    // Extract symbol from path parameters
    const symbol = event.pathParameters?.symbol;
    
    if (!symbol) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Symbol parameter is required" }),
      };
    }

    // Query orders by symbol
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "symbol = :symbol",
        ExpressionAttributeValues: {
          ":symbol": { S: symbol },
        },
      })
    );

    // Convert DynamoDB items to plain objects
    const orders = (result.Items || []).map((item) => {
      const unmarshalled = unmarshallItem(item);
      return {
        orderId: unmarshalled.orderId,
        symbol: unmarshalled.symbol,
        owner: unmarshalled.owner,
        price: parseFloat(unmarshalled.price),
        qty: parseFloat(unmarshalled.qty),
        side: unmarshalled.side,
        status: unmarshalled.status,
        createdAt: unmarshalled.createdAt,
        updatedAt: unmarshalled.updatedAt,
      };
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        symbol: symbol,
        count: orders.length,
        orders: orders,
      }),
    };
  } catch (err: any) {
    console.error("Error retrieving orders by symbol:", err);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Internal server error", message: err.message }),
    };
  }
};

