import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const table = process.env.CONNECTIONS_TABLE!;

export const handler = async (event: any) => {
  const connectionId = event.requestContext.connectionId;

  await ddb.send(
    new PutItemCommand({
      TableName: table,
      Item: { connectionId: { S: connectionId } },
    })
  );

  return { statusCode: 200 };
};
