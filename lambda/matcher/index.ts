import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { ethers } from "ethers";
import type { TransactionReceipt } from "ethers";
import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const settlementArtifact: { abi: any[] } = require("./abi/Settlement.json");

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const tableName = process.env.ORDERBOOK_TABLE!;
const tradeQueueUrl = process.env.TRADE_QUEUE_URL!;
const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT!;
const tradesTableName = process.env.TRADES_TABLE!;

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const avaxRpcUrl = requireEnv("AVAX_RPC_URL");
const settlementContractAddress = requireEnv("SETTLEMENT_CONTRACT_ADDRESS");
const settlementSignerKey = requireEnv("SETTLEMENT_SIGNER_KEY");
const opposingWalletAddress = requireEnv("OPPOSING_WALLET_ADDRESS");
const settlementConfirmations = Number(process.env.SETTLEMENT_CONFIRMATIONS ?? "1");

const provider = new ethers.JsonRpcProvider(avaxRpcUrl);
const signer = new ethers.Wallet(settlementSignerKey, provider);
const settlementContract = new ethers.Contract(
  settlementContractAddress,
  settlementArtifact.abi,
  signer
);

const supportedPairSeparators = ["/", "-", "_"] as const;

const assetMeta = [
  { symbol: "USDT", decimals: 6 },
  { symbol: "BTC", decimals: 8 },
  { symbol: "ETH", decimals: 18 },
  { symbol: "SOL", decimals: 9 },
  { symbol: "AVAX", decimals: 18 },
  { symbol: "LINK", decimals: 18 },
  { symbol: "DOGE", decimals: 8 },
  { symbol: "SUI", decimals: 9 },
] as const;

type AssetSymbol = (typeof assetMeta)[number]["symbol"];

const assetDecimals = assetMeta.reduce<Record<string, number>>((acc, { symbol, decimals }) => {
  acc[symbol] = decimals;
  return acc;
}, {});

const assetIds = assetMeta.reduce<Record<string, string>>((acc, { symbol }) => {
  acc[symbol] = ethers.id(symbol);
  return acc;
}, {});

const normalizeSymbol = (symbol: string): AssetSymbol => {
  const normalized = symbol.trim().toUpperCase();
  if (!(normalized in assetDecimals)) {
    throw new Error(`Unsupported asset symbol: ${normalized}`);
  }
  return normalized as AssetSymbol;
};

const parseTradingPair = (pair: string): [AssetSymbol, AssetSymbol] => {
  for (const separator of supportedPairSeparators) {
    if (pair.includes(separator)) {
      const [base, quote] = pair.split(separator);
      if (!base || !quote) {
        break;
      }
      return [normalizeSymbol(base), normalizeSymbol(quote)];
    }
  }
  throw new Error(`Unable to parse trading pair symbol: ${pair}`);
};

const toBigInt = (value: number | string, decimals: number): bigint =>
  ethers.parseUnits(
    typeof value === "number" ? value.toString() : value,
    decimals
  );

const calculateBalanceUpdates = (order: any) => {
  const [baseSymbol, quoteSymbol] = parseTradingPair(order.symbol);
  const baseDecimals = assetDecimals[baseSymbol];
  const quoteDecimals = assetDecimals[quoteSymbol];

  const side = (order.side || "BUY").toString().toUpperCase();
  const isBuy = side !== "SELL";

  const baseAmount: bigint = toBigInt(order.qty, baseDecimals);
  const priceAmount: bigint = toBigInt(order.price, quoteDecimals);
  const baseScale: bigint = 10n ** BigInt(baseDecimals);
  const quoteAmount: bigint = (baseAmount * priceAmount) / baseScale;

  const buyerAddress = isBuy ? order.owner : opposingWalletAddress;
  const sellerAddress = isBuy ? opposingWalletAddress : order.owner;

  const buyerBalanceUpdates = [
    {
      account: buyerAddress,
      assetId: assetIds[quoteSymbol],
      amount: (isBuy ? -quoteAmount : quoteAmount).toString(),
    },
    {
      account: buyerAddress,
      assetId: assetIds[baseSymbol],
      amount: (isBuy ? baseAmount : -baseAmount).toString(),
    },
  ];

  const sellerBalanceUpdates = [
    {
      account: sellerAddress,
      assetId: assetIds[quoteSymbol],
      amount: (isBuy ? quoteAmount : -quoteAmount).toString(),
    },
    {
      account: sellerAddress,
      assetId: assetIds[baseSymbol],
      amount: (isBuy ? -baseAmount : baseAmount).toString(),
    },
  ];

  return {
    balanceUpdates: [...buyerBalanceUpdates, ...sellerBalanceUpdates],
    baseSymbol,
    quoteSymbol,
    baseAmount,
    quoteAmount,
  };
};

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

      let settlementComputation: ReturnType<typeof calculateBalanceUpdates>;
      try {
        settlementComputation = calculateBalanceUpdates(order);
      } catch (err: any) {
        console.error("Error computing settlement balances:", err);
        await sendOrderMessage(connectionId, {
          type: "ORDER_ERROR",
          status: "ERROR",
          message: err?.message ?? "Failed to compute settlement balances",
        });
        return { statusCode: 400, body: JSON.stringify({ error: err?.message ?? "Invalid settlement parameters" }) };
      }

      const tradeHash = ethers.id(tradeId);
      let settlementReceipt: TransactionReceipt | undefined;

      try {
        const tx = await settlementContract.settleBatch(tradeHash, settlementComputation.balanceUpdates);
        const receipt = await tx.wait(Math.max(1, settlementConfirmations));
        console.log("Settlement transaction mined:", receipt.hash);
        settlementReceipt = receipt;
      } catch (err: any) {
        console.error("Error settling trade on chain:", err);
        await sendOrderMessage(connectionId, {
          type: "ORDER_ERROR",
          status: "ERROR",
          message: "Failed to settle trade on-chain",
        });
        return { statusCode: 502, body: JSON.stringify({ error: "Failed to settle trade on-chain" }) };
      }

      if (settlementReceipt) {
        try {
          await ddb.send(
            new UpdateItemCommand({
              TableName: tradesTableName,
              Key: {
                symbol: { S: order.symbol },
                tradeId: { S: tradeId },
              },
              UpdateExpression: "SET settlementTxHash = :txHash, settlementBlockNumber = :blockNumber",
              ExpressionAttributeValues: {
                ":txHash": { S: settlementReceipt.hash },
                ":blockNumber": { N: settlementReceipt.blockNumber?.toString() ?? "0" },
              },
            })
          );
        } catch (err: any) {
          console.warn("Failed to update trade with settlement details:", err);
        }
      }

      const settlementSummary = settlementReceipt
        ? {
            tradeHash,
            txHash: settlementReceipt.hash,
            blockNumber: settlementReceipt.blockNumber?.toString() ?? null,
            gasUsed: settlementReceipt.gasUsed?.toString() ?? null,
            gasPrice:
              "gasPrice" in settlementReceipt && settlementReceipt.gasPrice
                ? settlementReceipt.gasPrice.toString()
                : null,
          }
        : undefined;

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
        settlement: settlementSummary,
        balanceUpdates: settlementComputation.balanceUpdates,
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
