import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import axios from "axios";

type MarketData = {
  bid?: number;
  ask?: number;
  spread?: number;
  open24h?: number;
  high24h?: number;
  low24h?: number;
  close24h?: number;
  volume24h?: number;
  change24h?: number;
  marketCap?: number;
};

type PriceMessage = {
  type: "PRICE";
  channel: "prices";
  symbol: string;
  price: number;
  decimals: number;
  updatedAt: string;
  source: "BINANCE";
  marketData: MarketData;
};

type SymbolConfig = {
  symbol: string;
  supply?: number;
};

type SymbolConfigInput = string | SymbolConfig;

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

const connectionsTable = process.env.CONNECTIONS_TABLE!;
const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT!;
const binanceBaseUrl =
  process.env.BINANCE_BASE_URL ?? "https://api.binance.com/api/v3";

const safeJsonParse = (value?: string) => {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    console.error("Failed to parse BINANCE_SYMBOL_MAP", error);
    return {};
  }
};

const rawOverrides = safeJsonParse(process.env.BINANCE_SYMBOL_MAP);

const binanceSymbolConfigs: Record<string, SymbolConfig> = Object.keys({
  ...DEFAULT_SYMBOL_MAP,
  ...rawOverrides,
}).reduce((acc, symbol) => {
  const baseConfig = DEFAULT_SYMBOL_MAP[symbol] ?? { symbol: "" };
  const overrideInput: SymbolConfigInput | undefined = rawOverrides[symbol];
  const overrideConfig: SymbolConfig =
    typeof overrideInput === "string"
      ? { symbol: overrideInput }
      : overrideInput ?? baseConfig;

  const merged: SymbolConfig = {
    symbol: overrideConfig.symbol ?? baseConfig.symbol,
    supply: overrideConfig.supply ?? baseConfig.supply,
  };

  if (merged.symbol) {
    acc[symbol] = merged;
  }

  return acc;
}, {} as Record<string, SymbolConfig>);

const ddb = new DynamoDBClient({});
const mgmt = new ApiGatewayManagementApiClient({
  endpoint: websocketEndpoint,
});

const toNumber = (value: any): number | undefined => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const fetchTicker24h = async (symbolIds: string[]) => {
  if (!symbolIds.length) {
    return [];
  }

  const url = `${binanceBaseUrl.replace(
    /\/$/,
    ""
  )}/ticker/24hr?${new URLSearchParams({
    symbols: JSON.stringify(symbolIds),
  })}`;

  const response = await axios({
    url,
    method: "GET",
    timeout: 5_000,
  });

  if (!Array.isArray(response.data)) {
    throw new Error("Unexpected Binance response");
  }

  return response.data as Array<Record<string, any>>;
};

const buildMarketData = (
  symbol: string,
  symbolConfig: SymbolConfig,
  payload: Record<string, any>
) => {
  const price = toNumber(payload.lastPrice);
  if (price === undefined) {
    throw new Error(`Missing price for ${symbol} (${symbolConfig.symbol})`);
  }

  const open24h = toNumber(payload.openPrice);
  const high24h = toNumber(payload.highPrice);
  const low24h = toNumber(payload.lowPrice);
  const close24h = price;
  const volume24h = toNumber(payload.volume);
  const change24h = toNumber(payload.priceChangePercent);

  const bid = toNumber(payload.bidPrice);
  const ask = toNumber(payload.askPrice);
  const spread =
    bid !== undefined && ask !== undefined ? ask - bid : undefined;

  const marketData: MarketData = {
    bid,
    ask,
    spread,
    open24h,
    high24h,
    low24h,
    close24h,
    volume24h,
    change24h,
    marketCap: undefined,
  };

  if (
    symbolConfig.supply &&
    marketData.marketCap === undefined &&
    price !== undefined
  ) {
    marketData.marketCap = price * symbolConfig.supply;
  }

  return {
    symbol,
    price,
    decimals: toNumber(payload.lastQty ?? 2) ?? 2,
    updatedAt:
      payload.closeTime ||
      payload.eventTime ||
      new Date().toISOString(),
    marketData,
  };
};

const broadcastPrices = async (messages: PriceMessage[]) => {
  if (!messages.length) {
    return;
  }

  const connections = await ddb.send(
    new ScanCommand({
      TableName: connectionsTable,
    })
  );

  if (!connections.Items?.length) {
    return;
  }

  await Promise.allSettled(
    connections.Items.map(async (item) => {
      const connectionId = item.connectionId.S;
      if (!connectionId) {
        return;
      }

      for (const message of messages) {
        try {
          await mgmt.send(
            new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify(message)),
            })
          );
        } catch (error: any) {
          if (error.statusCode === 410) {
            // stale connection; ignore and let disconnect handler clean it up
            return;
          }
          console.error(
            `Failed to send price update to ${connectionId} for ${message.symbol}:`,
            error
          );
        }
      }
    })
  );
};

export const handler = async () => {
  const symbols = Object.keys(binanceSymbolConfigs);
  const priceMessages: PriceMessage[] = [];

  try {
    const tickerPayload = await fetchTicker24h(
      symbols.map((symbol) => binanceSymbolConfigs[symbol].symbol)
    );

    const tickerBySymbol = new Map(
      tickerPayload
        .map((item) => [item.symbol, item] as const)
        .filter(([id]) => typeof id === "string")
    );

    for (const symbol of symbols) {
      const config = binanceSymbolConfigs[symbol];
      try {
        const payload = tickerBySymbol.get(config.symbol);
        if (!payload) {
          throw new Error(`No data returned for symbol ${config.symbol}`);
        }

        const result = buildMarketData(symbol, config, payload);
        priceMessages.push({
          type: "PRICE",
          channel: "prices",
          symbol: result.symbol,
          price: result.price,
          decimals: result.decimals,
          updatedAt: new Date(result.updatedAt).toISOString(),
          source: "BINANCE",
          marketData: result.marketData,
        });
      } catch (error) {
        console.error(`Failed to build market data for ${symbol}`, error);
      }
    }
  } catch (error) {
    console.error("Failed to fetch data from Binance", error);
  }

  await broadcastPrices(priceMessages);

  return {
    statusCode: 200,
    body: JSON.stringify({ published: priceMessages.length }),
  };
};

