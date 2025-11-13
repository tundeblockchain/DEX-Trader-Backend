import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ethers } from "ethers";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const settlementArtifact: { abi: any[] } = require("./abi/Settlement.json");

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

const unwrapJsonString = (raw: string, label: string, preferredKeys: string[] = []): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} is empty`);
  }

  const searchKeys = [...preferredKeys, "value", "address", "secret", "privateKey", "key"];

  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed.trim();
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of searchKeys) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) {
          return candidate.trim();
        }
      }
      const fallback = Object.values(record).find(
        (value) => typeof value === "string" && value.trim()
      ) as string | undefined;
      if (fallback) {
        return fallback.trim();
      }
    }
  } catch (err: any) {
    throw new Error(`${label} contains invalid JSON: ${err?.message ?? String(err)}`);
  }

  throw new Error(`${label} JSON payload does not contain a usable string value`);
};

const extractAddress = (raw: string, label: string, preferredKeys: string[] = []): string => {
  const candidate = unwrapJsonString(raw, label, preferredKeys);
  if (!ethers.isAddress(candidate)) {
    throw new Error(`${label} must contain a valid address string`);
  }
  return ethers.getAddress(candidate);
};

const avaxRpcUrl = requireEnv("AVAX_RPC_URL");
const settlementContractAddress = extractAddress(
  requireEnv("SETTLEMENT_CONTRACT_ADDRESS"),
  "SETTLEMENT_CONTRACT_ADDRESS",
  ["contractAddress"]
);
const adminPrivateKeySecretArn = requireEnv("SETTLEMENT_ADMIN_PRIVATE_KEY_SECRET_ARN");
const adminAddress = extractAddress(
  requireEnv("SETTLEMENT_ADMIN_ADDRESS"),
  "SETTLEMENT_ADMIN_ADDRESS",
  ["walletDeployer"]
).toLowerCase();
const confirmations = Number(process.env.SETTLEMENT_ADMIN_CONFIRMATIONS ?? "1");

const provider = new ethers.JsonRpcProvider(avaxRpcUrl);
const secretsClient = new SecretsManagerClient({});

const loadSecretString = async (
  secretArn: string,
  label: string,
  preferredKeys: string[] = []
): Promise<string> => {
  const result = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: secretArn,
    })
  );

  const secretBinary = result.SecretBinary;
  const raw =
    result.SecretString ?? (secretBinary ? Buffer.from(secretBinary).toString("utf8") : undefined);

  if (!raw) {
    throw new Error(`${label} secret (${secretArn}) did not contain a string value`);
  }

  return unwrapJsonString(raw, label, preferredKeys);
};

const secretPreferredKeys = ["privateKey", "value", "key"];

let adminPrivateKeyPromise: Promise<string> | undefined;
const getAdminPrivateKey = async (): Promise<string> => {
  if (!adminPrivateKeyPromise) {
    adminPrivateKeyPromise = (async () => {
      try {
        return await loadSecretString(
          adminPrivateKeySecretArn,
          "SETTLEMENT_ADMIN_PRIVATE_KEY",
          secretPreferredKeys
        );
      } catch (err) {
        console.error("Failed to load admin private key:", err);
        throw err;
      }
    })();
  }
  return adminPrivateKeyPromise;
};

let adminSignerPromise: Promise<ethers.Wallet> | undefined;
const getAdminSigner = async (): Promise<ethers.Wallet> => {
  if (!adminSignerPromise) {
    adminSignerPromise = (async () => {
      const privateKey = await getAdminPrivateKey();
      const signer = new ethers.Wallet(privateKey, provider);
      if (signer.address.toLowerCase() !== adminAddress) {
        throw new Error("Admin private key does not correspond to SETTLEMENT_ADMIN_ADDRESS");
      }
      return signer;
    })();
  }
  return adminSignerPromise;
};

let contractPromise: Promise<ethers.Contract> | undefined;
const getAdminContract = async (): Promise<ethers.Contract> => {
  if (!contractPromise) {
    contractPromise = (async () => {
      const signer = await getAdminSigner();
      return new ethers.Contract(settlementContractAddress, settlementArtifact.abi, signer);
    })();
  }
  return contractPromise;
};

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
    const minConfirmations = Math.max(1, Number.isFinite(confirmations) ? confirmations : 1);
    const contract = await getAdminContract();
    let txReceipt: ethers.TransactionReceipt;

    if (action === "register") {
      if (!payload.tokenAddress || !ethers.isAddress(payload.tokenAddress)) {
        return response(400, { error: "tokenAddress must be a valid address for register action" });
      }

      const tx = await contract.registerAsset(assetId, payload.tokenAddress);
      txReceipt = await tx.wait(minConfirmations);

      return response(200, {
        status: "registered",
        symbol: normalizedSymbol,
        assetId,
        txHash: txReceipt.hash,
        blockNumber: txReceipt.blockNumber,
      });
    }

    const tx = await contract.unregisterAsset(assetId);
    txReceipt = await tx.wait(minConfirmations);

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

