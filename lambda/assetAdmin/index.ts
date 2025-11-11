import { ethers } from "ethers";
import settlementArtifact from "../shared/abi/Settlement.json";

type SupportedAction = "register" | "unregister";

type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const avaxRpcUrl = requireEnv("AVAX_RPC_URL");
const settlementContractAddress = requireEnv("SETTLEMENT_CONTRACT_ADDRESS");
const adminPrivateKey = requireEnv("SETTLEMENT_ADMIN_PRIVATE_KEY");
const adminAddress = requireEnv("SETTLEMENT_ADMIN_ADDRESS").toLowerCase();
const confirmations = Number(process.env.SETTLEMENT_ADMIN_CONFIRMATIONS ?? "1");

const provider = new ethers.JsonRpcProvider(avaxRpcUrl);
const signer = new ethers.Wallet(adminPrivateKey, provider);

if (signer.address.toLowerCase() !== adminAddress) {
  throw new Error("Admin private key does not correspond to SETTLEMENT_ADMIN_ADDRESS");
}

const contract = new ethers.Contract(
  settlementContractAddress,
  settlementArtifact.abi,
  signer
);

interface RegisterPayload {
  action: SupportedAction;
  symbol: string;
  tokenAddress?: string;
}

const response = (
  statusCode: number,
  body: Record<string, unknown>
): HttpResponse => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true",
  },
  body: JSON.stringify(body),
});

const parsePayload = (event: any): RegisterPayload => {
  if (event?.httpMethod === "OPTIONS") {
    return { action: "register", symbol: "", tokenAddress: undefined };
  }

  const rawBody = typeof event.body === "string" ? event.body : JSON.stringify(event.body ?? {});
  try {
    return JSON.parse(rawBody);
  } catch (err) {
    throw new Error("Invalid JSON payload");
  }
};

const toAssetId = (symbol: string): { assetId: string; normalizedSymbol: string } => {
  if (!symbol || typeof symbol !== "string") {
    throw new Error("Missing asset symbol");
  }

  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    throw new Error("Asset symbol cannot be empty");
  }

  return { assetId: ethers.id(normalized), normalizedSymbol: normalized };
};

export const handler = async (event: any): Promise<HttpResponse> => {
  if (event?.httpMethod === "OPTIONS") {
    return response(200, { ok: true });
  }

  try {
    const payload = parsePayload(event);
    const action = payload.action?.toLowerCase() as SupportedAction;

    if (action !== "register" && action !== "unregister") {
      return response(400, { error: "action must be 'register' or 'unregister'" });
    }

    const { assetId, normalizedSymbol } = toAssetId(payload.symbol);
    let txReceipt: ethers.TransactionReceipt;

    if (action === "register") {
      if (!payload.tokenAddress || !ethers.isAddress(payload.tokenAddress)) {
        return response(400, { error: "tokenAddress must be a valid address for register action" });
      }

      const tx = await contract.registerAsset(assetId, payload.tokenAddress);
      txReceipt = await tx.wait(Math.max(1, confirmations));

      return response(200, {
        status: "registered",
        symbol: normalizedSymbol,
        assetId,
        txHash: txReceipt.hash,
        blockNumber: txReceipt.blockNumber,
      });
    }

    const tx = await contract.unregisterAsset(assetId);
    txReceipt = await tx.wait(Math.max(1, confirmations));

    return response(200, {
      status: "unregistered",
      symbol: normalizedSymbol,
      assetId,
      txHash: txReceipt.hash,
      blockNumber: txReceipt.blockNumber,
    });
  } catch (err: any) {
    console.error("Asset admin handler error:", err);
    return response(500, {
      error: "Failed to process asset admin request",
      message: err?.message ?? "Unknown error",
    });
  }
};

