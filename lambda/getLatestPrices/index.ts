import axios from "axios";

type SymbolConfig = {
  symbol: string;
};

type SymbolOverrideInput = string | SymbolConfig;

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
          acc[key] = override;
        }
        return acc;
      },
      {} as Record<string, SymbolConfig>
    );
  } catch (error) {
    console.error("Failed to parse BINANCE_SYMBOL_MAP in getLatestPrices", error);
    return {};
  }
};

const symbolConfigs: Record<string, SymbolConfig> = {
  ...DEFAULT_SYMBOL_MAP,
  ...parseOverrides(),
};

const fetchTicker24hr = async (symbols: string[]) => {
  if (!symbols.length) {
    return [];
  }

  const url = `${binanceBaseUrl.replace(
    /\/$/,
    ""
  )}/ticker/24hr?${new URLSearchParams({
    symbols: JSON.stringify(symbols),
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

const toNumber = (value: any) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

export const handler = async () => {
  const logicalSymbols = Object.keys(symbolConfigs);
  try {
    const binanceSymbols = logicalSymbols.map(
      (symbol) => symbolConfigs[symbol].symbol
    );
    const tickers = await fetchTicker24hr(binanceSymbols);

    const bySymbol = new Map(
      tickers
        .map((item) => [item.symbol, item] as const)
        .filter(([symbol]) => typeof symbol === "string")
    );

    const results = logicalSymbols
      .map((logicalSymbol) => {
        const config = symbolConfigs[logicalSymbol];
        const payload = bySymbol.get(config.symbol);
        if (!payload) {
          return {
            symbol: logicalSymbol,
            status: "MISSING",
          };
        }

        const price = toNumber(payload.lastPrice);
        const open24h = toNumber(payload.openPrice);
        const high24h = toNumber(payload.highPrice);
        const low24h = toNumber(payload.lowPrice);
        const volume24h = toNumber(payload.volume);
        const change24h = toNumber(payload.priceChangePercent);

        return {
          symbol: logicalSymbol,
          price,
          open24h,
          high24h,
          low24h,
          close24h: price,
          volume24h,
          change24h,
          updatedAt:
            payload.closeTime || payload.eventTime || new Date().toISOString(),
          sourceSymbol: config.symbol,
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        symbols: results,
      }),
    };
  } catch (error: any) {
    console.error("Failed to fetch Binance prices", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Failed to fetch latest prices",
        message: error?.message ?? "Unknown error",
      }),
    };
  }
};

