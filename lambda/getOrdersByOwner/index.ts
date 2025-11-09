import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const tableName = process.env.ORDERBOOK_TABLE!;
const ownerIndexName = process.env.OWNER_INDEX_NAME!;

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
    // Extract owner (crypto address) from path parameters
    const owner = event.pathParameters?.owner;
    
    if (!owner) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Owner parameter is required" }),
      };
    }

    // Query orders by owner using GSI
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: ownerIndexName,
        KeyConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: {
          "#owner": "owner",
        },
        ExpressionAttributeValues: {
          ":owner": { S: owner },
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
        type: unmarshalled.type,
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
        owner: owner,
        count: orders.length,
        orders: orders,
      }),
    };
  } catch (err: any) {
    console.error("Error retrieving orders by owner:", err);
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

