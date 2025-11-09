import { BatchWriteItemCommand, DynamoDBClient, WriteRequest } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "crypto";

type OrderSide = "BUY" | "SELL";
type OrderStatus = "FILLED" | "PENDING";
type OrderType = "limit" | "market";

type OrderRecord = {
  orderId: string;
  symbol: string;
  owner: string;
  price: number;
  qty: number;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  matchedAt?: string;
  tradeId?: string;
};

type TradeRecord = {
  tradeId: string;
  symbol: string;
  orderId: string;
  owner: string;
  price: number;
  qty: number;
  side: OrderSide;
  type: OrderType;
  matchedAt: string;
  createdAt: string;
};

type SymbolConfig = {
  symbol: string;
};

type GenerateRequestBody = {
  symbols?: string[];
  perSideCount?: number;
  clearExisting?: boolean;
};

const ddb = new DynamoDBClient({});

const DEFAULT_SYMBOL_MAP: Record<string, SymbolConfig> = {
  BTC: { symbol: "BTCUSDT" },
  ETH: { symbol: "ETHUSDT" },
  SOL: { symbol: "SOLUSDT" },
  AVAX: { symbol: "AVAXUSDT" },
  BNB: { symbol: "BNBUSDT" },
  DOGE: { symbol: "DOGEUSDT" },
  SUI: { symbol: "SUIUSDT" },
  LINK: { symbol: "LINKUSDT" },
};

const ORDERBOOK_TABLE = process.env.ORDERBOOK_TABLE!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const BINANCE_BASE_URL =
  process.env.BINANCE_BASE_URL ?? "https://api.binance.com/api/v3";

const parseBinanceSymbolOverrides = () => {
  if (!process.env.BINANCE_SYMBOL_MAP) {
    return {};
  }

  try {
    return JSON.parse(process.env.BINANCE_SYMBOL_MAP) as Record<
      string,
      string | SymbolConfig
    >;
  } catch (error) {
    console.error("Failed to parse BINANCE_SYMBOL_MAP:", error);
    return {};
  }
};

const resolveSymbolMap = (): Record<string, SymbolConfig> => {
  const overrides = parseBinanceSymbolOverrides();
  const merged = { ...DEFAULT_SYMBOL_MAP };

  for (const [symbol, override] of Object.entries(overrides)) {
    if (typeof override === "string") {
      merged[symbol] = { symbol: override };
    } else if (override && typeof override === "object") {
      merged[symbol] = { symbol: override.symbol ?? merged[symbol]?.symbol ?? "" };
    }

    if (!merged[symbol]?.symbol) {
      delete merged[symbol];
    }
  }

  return merged;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs = 5000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchBinancePrices = async (
  resolvedSymbols: Record<string, SymbolConfig>
): Promise<Record<string, number>> => {
  const exchangeSymbols = Object.values(resolvedSymbols)
    .map((cfg) => cfg.symbol)
    .filter((symbol) => symbol);

  if (!exchangeSymbols.length) {
    throw new Error("No Binance symbols configured");
  }

  const url = `${
    BINANCE_BASE_URL.replace(/\/$/, "")}/ticker/price?${new URLSearchParams({
    symbols: JSON.stringify(exchangeSymbols),
  }).toString()}`;

  const response = await fetchWithTimeout(url, { method: "GET" });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch prices from Binance: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();
  const prices: Record<string, number> = {};

  const priceArray: Array<{ symbol: string; price: string }> = Array.isArray(payload)
    ? payload
    : [payload];

  const priceByExchangeSymbol = new Map<string, number>();
  for (const entry of priceArray) {
    const value = Number(entry.price);
    if (!Number.isFinite(value)) {
      continue;
    }
    priceByExchangeSymbol.set(entry.symbol, value);
  }

  for (const [symbol, config] of Object.entries(resolvedSymbols)) {
    const price = priceByExchangeSymbol.get(config.symbol);
    if (price !== undefined) {
      prices[symbol] = price;
    }
  }

  return prices;
};

const randomWithinPercent = (base: number, percent = 0.05) => {
  const minFactor = 1 - percent;
  const maxFactor = 1 + percent;
  const factor = minFactor + Math.random() * (maxFactor - minFactor);
  return parseFloat((base * factor).toFixed(2));
};

const randomQuantity = () => {
  const min = 0.01;
  const max = 5;
  return parseFloat((min + Math.random() * (max - min)).toFixed(4));
};

const mockOwners = Array.from({ length: 50 }, (_, index) => `mock-user-${index + 1}`);

const pickOwner = () =>
  mockOwners[Math.floor(Math.random() * mockOwners.length)];

const buildOrderItem = (order: OrderRecord) => ({
  symbol: { S: order.symbol },
  orderId: { S: order.orderId },
  owner: { S: order.owner },
  price: { N: order.price.toString() },
  qty: { N: order.qty.toString() },
  side: { S: order.side },
  type: { S: order.type },
  status: { S: order.status },
  createdAt: { S: order.createdAt },
  updatedAt: { S: order.updatedAt },
});

const buildTradeItem = (trade: TradeRecord) => ({
  symbol: { S: trade.symbol },
  tradeId: { S: trade.tradeId },
  orderId: { S: trade.orderId },
  owner: { S: trade.owner },
  price: { N: trade.price.toString() },
  qty: { N: trade.qty.toString() },
  side: { S: trade.side },
  type: { S: trade.type },
  matchedAt: { S: trade.matchedAt },
  createdAt: { S: trade.createdAt },
});

const batchWriteAll = async (tableName: string, items: Record<string, any>[]) => {
  const batches = chunk(items, 25);

  for (const batch of batches) {
    let pending: WriteRequest[] = batch.map((item) => ({
      PutRequest: { Item: item },
    }));

    let attempt = 0;
    while (pending.length) {
      const command = new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: pending,
        },
      });

      const response = await ddb.send(command);
      const unprocessed = response.UnprocessedItems?.[tableName] ?? [];

      pending = unprocessed;

      if (pending.length) {
        attempt += 1;
        const backoff = Math.min(2 ** attempt * 50, 1000);
        await wait(backoff);
      }
    }
  }
};

const parseRequestBody = (event: any): GenerateRequestBody => {
  if (!event?.body) {
    return {};
  }

  try {
    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    return body ?? {};
  } catch (error) {
    console.warn("Failed to parse request body:", error);
    return {};
  }
};

const maybeClearTables = async (clearExisting: boolean) => {
  if (!clearExisting) {
    return;
  }

  console.warn(
    "clearExisting=true requested, but clearing tables is not implemented to avoid accidental data loss."
  );
};

export const handler = async (event: any) => {
  try {
    const body = parseRequestBody(event);
    const symbolMap = resolveSymbolMap();
    const perSideCount = Math.max(1, Math.min(200, body.perSideCount ?? 200));
    const targetSymbols = (body.symbols?.length ? body.symbols : Object.keys(symbolMap)).filter(
      (symbol) => symbolMap[symbol]
    );

    if (!targetSymbols.length) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "No valid symbols provided" }),
      };
    }

    await maybeClearTables(!!body.clearExisting);

    const prices = await fetchBinancePrices(
      targetSymbols.reduce((acc, symbol) => {
        acc[symbol] = symbolMap[symbol];
        return acc;
      }, {} as Record<string, SymbolConfig>)
    );

    const orders: Record<string, any>[] = [];
    const trades: Record<string, any>[] = [];
    const summary: Record<string, { orders: number; trades: number }> = {};

    const now = Date.now();

    for (const symbol of targetSymbols) {
      const basePrice = prices[symbol];
      if (!Number.isFinite(basePrice)) {
        console.warn(`Skipping ${symbol}: missing Binance price`);
        continue;
      }

      summary[symbol] = { orders: 0, trades: 0 };

      for (const side of ["BUY", "SELL"] as OrderSide[]) {
        for (let i = 0; i < perSideCount; i += 1) {
          const createdAt = new Date(now - Math.floor(Math.random() * 86_400_000));
          const matchedAt = new Date(
            createdAt.getTime() + Math.floor(Math.random() * 60_000)
          );

          const order: OrderRecord = {
            orderId: randomUUID(),
            symbol,
            owner: pickOwner(),
            price: randomWithinPercent(basePrice),
            qty: randomQuantity(),
            side,
            type: "limit",
            status: "FILLED",
            createdAt: createdAt.toISOString(),
            updatedAt: matchedAt.toISOString(),
            matchedAt: matchedAt.toISOString(),
          };

          const trade: TradeRecord = {
            tradeId: randomUUID(),
            symbol,
            orderId: order.orderId,
            owner: order.owner,
            price: order.price,
            qty: order.qty,
            side: order.side,
            type: order.type,
            matchedAt: order.matchedAt!,
            createdAt: order.createdAt,
          };

          orders.push(buildOrderItem(order));
          trades.push(buildTradeItem(trade));

          summary[symbol].orders += 1;
          summary[symbol].trades += 1;
        }
      }
    }

    if (!orders.length || !trades.length) {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Failed to generate mock data",
          details: "No orders or trades were created",
        }),
      };
    }

    await batchWriteAll(ORDERBOOK_TABLE, orders);
    await batchWriteAll(TRADES_TABLE, trades);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        message: "Mock orders and trades generated successfully",
        perSideCount,
        symbols: summary,
        totals: {
          orders: orders.length,
          trades: trades.length,
        },
      }),
    };
  } catch (error: any) {
    console.error("Failed to generate mock data:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Internal server error",
        message: error?.message ?? "Unknown error",
      }),
    };
  }
};


