import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const table = process.env.CONNECTIONS_TABLE!;

export const handler = async (event: any) => {
  const connectionId = event.requestContext.connectionId;

  await ddb.send(
    new DeleteItemCommand({
      TableName: table,
      Key: { connectionId: { S: connectionId } },
    })
  );

  return { statusCode: 200 };
};
