import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const tradesTable = process.env.TRADES_TABLE!;
const ownerIndex = process.env.TRADES_OWNER_INDEX!;

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

    const result = await ddb.send(
      new QueryCommand({
        TableName: tradesTable,
        IndexName: ownerIndex,
        KeyConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: {
          "#owner": "owner",
        },
        ExpressionAttributeValues: {
          ":owner": { S: owner },
        },
      })
    );

    const trades = (result.Items || []).map((item) => {
      const unmarshalled = unmarshallItem(item);
      return {
        tradeId: unmarshalled.tradeId,
        orderId: unmarshalled.orderId,
        symbol: unmarshalled.symbol,
        owner: unmarshalled.owner,
        price: parseFloat(unmarshalled.price),
        qty: parseFloat(unmarshalled.qty),
        side: unmarshalled.side,
        type: unmarshalled.type,
        matchedAt: unmarshalled.matchedAt,
        createdAt: unmarshalled.createdAt,
      };
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        owner,
        count: trades.length,
        trades,
      }),
    };
  } catch (err: any) {
    console.error("Error retrieving trades by owner:", err);
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
