import type { APIGatewayProxyEventV2 } from "aws-lambda";

type SymbolConfig = {
  symbol: string;
};

type SymbolOverrideInput = string | SymbolConfig;

const DEFAULT_SYMBOL_SUFFIX = "USDT";

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

const binanceBaseUrl =
  process.env.BINANCE_BASE_URL ?? "https://api.binance.com/api/v3";

const symbolOverridesEnv = process.env.BINANCE_SYMBOL_MAP;

const parseOverrides = (): Record<string, SymbolConfig> => {
  if (!symbolOverridesEnv) {
    return {};
  }

  try {
    const parsed = JSON.parse(symbolOverridesEnv);
    return Object.entries(parsed).reduce(
      (acc, [key, value]) => {
        if (!value) {
          return acc;
        }

        const override: SymbolConfig =
          typeof value === "string" ? { symbol: value } : (value as SymbolConfig);

        if (override.symbol) {
          acc[key.toUpperCase()] = {
            symbol: override.symbol.toUpperCase(),
          };
        }
        return acc;
      },
      {} as Record<string, SymbolConfig>
    );
  } catch (error) {
    console.error("Failed to parse BINANCE_SYMBOL_MAP in getCandlesticks", error);
    return {};
  }
};

const symbolConfigs: Record<string, SymbolConfig> = {
  ...DEFAULT_SYMBOL_MAP,
  ...parseOverrides(),
};

const normalizeLogicalSymbol = (input: string) =>
  input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

const toBinanceSymbol = (symbol: string) => {
  const logicalSymbol = normalizeLogicalSymbol(symbol);
  const override = symbolConfigs[logicalSymbol];
  if (override?.symbol) {
    return { logicalSymbol, exchangeSymbol: override.symbol };
  }

  if (
    logicalSymbol.endsWith("USDT") ||
    logicalSymbol.endsWith("BUSD") ||
    logicalSymbol.endsWith("USDC")
  ) {
    return { logicalSymbol, exchangeSymbol: logicalSymbol };
  }

  return {
    logicalSymbol,
    exchangeSymbol: `${logicalSymbol}${DEFAULT_SYMBOL_SUFFIX}`,
  };
};

const clampLimit = (input: number | undefined) => {
  if (!Number.isFinite(input)) {
    return 500;
  }
  return Math.min(1000, Math.max(10, Math.floor(input)));
};

const isValidInterval = (interval: string) => {
  const supported = new Set([
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
  ]);
  return supported.has(interval);
};

const buildKlineUrl = (symbol: string, interval: string, limit: number) => {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  const base = binanceBaseUrl.replace(/\/$/, "");
  return `${base}/klines?${params.toString()}`;
};

const mapCandle = (payload: any[]) => ({
  openTime: Number(payload[0]),
  open: Number(payload[1]),
  high: Number(payload[2]),
  low: Number(payload[3]),
  close: Number(payload[4]),
  volume: Number(payload[5]),
  closeTime: Number(payload[6]),
  quoteAssetVolume: Number(payload[7]),
  numberOfTrades: Number(payload[8]),
  takerBuyBaseAssetVolume: Number(payload[9]),
  takerBuyQuoteAssetVolume: Number(payload[10]),
});

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
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

    const queryInterval = event.queryStringParameters?.interval;
    const interval = queryInterval && isValidInterval(queryInterval)
      ? queryInterval
      : "1d";

    const limitParam = event.queryStringParameters?.limit;
    const limit = clampLimit(limitParam ? Number(limitParam) : undefined);

    const { logicalSymbol, exchangeSymbol } = toBinanceSymbol(symbol);

    const url = buildKlineUrl(exchangeSymbol, interval, limit);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Binance klines request failed", {
        status: response.status,
        statusText: response.statusText,
        text,
      });
      return {
        statusCode: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Failed to fetch candlestick data",
          status: response.status,
          message: response.statusText,
        }),
      };
    }

    const data = (await response.json()) as any[];

    if (!Array.isArray(data)) {
      throw new Error("Unexpected response format from Binance klines");
    }

    const candles = data.map(mapCandle);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        symbol: logicalSymbol,
        exchangeSymbol,
        interval,
        limit,
        candles,
      }),
    };
  } catch (error: any) {
    console.error("Failed to retrieve candlestick data", error);
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

