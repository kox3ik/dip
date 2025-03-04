import {
  Transaction,
  VersionedTransaction,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { NATIVE_MINT, getAccount } from "@solana/spl-token";
import axios from "axios";
import { connection, owner, fetchTokenAccountData } from "./config";
import { API_URLS } from "@raydium-io/raydium-sdk-v2";
import bs58 from "bs58";
const { JitoJsonRpcClient } = require("./jito.js");

const jitoClient = new JitoJsonRpcClient("hhttps://ny.mainnet.block-engine.jito.wtf/api/v1");
const JITO_TIP_AMOUNT = 20000000;

interface SwapCompute {
  id: string;
  success: true;
  version: "V0" | "V1";
  openTime?: undefined;
  msg: undefined;
  data: {
    swapType: "BaseIn" | "BaseOut";
    inputMint: string;
    inputAmount: string;
    outputMint: string;
    outputAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: number;
    routePlan: {
      poolId: string;
      inputMint: string;
      outputMint: string;
      feeMint: string;
      feeRate: number;
      feeAmount: string;
    }[];
  };
}


const createAndSignTransaction = async (
  txBuf: Buffer,
  isV0Tx: boolean,
  owner: any,
  jitoTipAccount?: PublicKey,
  jitoTipAmount?: number,
  recentBlockhash?: string
) => {
  const tx = isV0Tx
    ? VersionedTransaction.deserialize(txBuf)
    : Transaction.from(txBuf);

  if (!isV0Tx && jitoTipAccount && jitoTipAmount && recentBlockhash) {
    const legacyTx = tx as Transaction;
    legacyTx.add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: jitoTipAccount,
        lamports: jitoTipAmount,
      })
    );
    legacyTx.recentBlockhash = recentBlockhash;
  }

  if (isV0Tx) {
    const v0Tx = tx as VersionedTransaction;
    v0Tx.sign([owner]);
    return bs58.encode(v0Tx.serialize());
  } else {
    const legacyTx = tx as Transaction;
    legacyTx.sign(owner);
    return bs58.encode(legacyTx.serialize());
  }
};

export const swapTokens = async ({
  action,
  mintCA,
  amount,
  slippage = 20,
  txVersion = "LEGACY",
}: {
  action: "buy" | "sell";
  mintCA: string;
  amount?: number;
  slippage?: number;
  txVersion?: "V0" | "LEGACY";
}) => {
  const isV0Tx = txVersion === "V0";
  const isBuy = action === "buy";

  const [inputMint, outputMint] = isBuy
    ? [NATIVE_MINT.toBase58(), mintCA]
    : [mintCA, NATIVE_MINT.toBase58()];

  const { tokenAccounts } = await fetchTokenAccountData();
  const inputTokenAcc = tokenAccounts.find(
    (a) => a.mint.toBase58() === inputMint
  )?.publicKey;
  const outputTokenAcc = tokenAccounts.find(
    (a) => a.mint.toBase58() === outputMint
  )?.publicKey;

  if (!inputTokenAcc && inputMint !== NATIVE_MINT.toBase58()) {
    console.error("У вас нет аккаунта для входного токена!");
    return;
  }

  const randomTipAccount = await jitoClient.getRandomTipAccount();
  const jitoTipAccount = new PublicKey(randomTipAccount);

  if (!isBuy) {
    try {
      const tokenAccountInfo = await getAccount(connection, inputTokenAcc!);
      amount = Number(tokenAccountInfo.amount);
      console.log(`Продаем ${amount} токенов ${mintCA}`);
    } catch (error) {
      console.error("Ошибка получения баланса токена:", error);
      return;
    }
  }

  // Параллельные запросы
  const [priorityFeeResponse, swapResponse] = await Promise.all([
    axios.get<{
      id: string;
      success: boolean;
      data: { default: { vh: number; h: number; m: number } };
    }>(`${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`),
    axios.get<SwapCompute>(
      `${
        API_URLS.SWAP_HOST
      }/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${
        slippage * 100
      }&txVersion=${txVersion}`
    ),
  ]);

  const { data: swapTransactions } = await axios.post<{
    id: string;
    version: string;
    success: boolean;
    data: { transaction: string }[];
  }>(`${API_URLS.SWAP_HOST}/transaction/swap-base-in`, {
    computeUnitPriceMicroLamports: String(priorityFeeResponse.data.data.default.vh),
    swapResponse: swapResponse.data,
    txVersion,
    wallet: owner.publicKey.toBase58(),
    wrapSol: inputMint === NATIVE_MINT.toBase58() && outputMint !== NATIVE_MINT.toBase58(),
    unwrapSol: outputMint === NATIVE_MINT.toBase58() && inputMint !== NATIVE_MINT.toBase58(),
    inputAccount: inputMint === NATIVE_MINT.toBase58() ? undefined : inputTokenAcc?.toBase58(),
    outputAccount: outputMint === NATIVE_MINT.toBase58() ? undefined : outputTokenAcc?.toBase58(),
  });

  const allTxBuf = swapTransactions.data.map((tx) => Buffer.from(tx.transaction, "base64"));
  const recentBlockhash = (await connection.getRecentBlockhash()).blockhash;

  const encodedSignedTransactions = await Promise.all(
    allTxBuf.map((txBuf) =>
      createAndSignTransaction(txBuf, isV0Tx, owner, jitoTipAccount, JITO_TIP_AMOUNT, recentBlockhash)
    )
  );

  try {
    const jitoResponse = await fetch(
      `https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [encodedSignedTransactions],
        }),
      }
    );

    const jitoResponseText = await jitoResponse.text();
    console.log("Jito response:", jitoResponseText);

    const jitoResponseJson = JSON.parse(jitoResponseText);
    if (jitoResponseJson.error) {
      throw new Error(`Jito error: ${jitoResponseJson.error.message}`);
    }
  } catch (e) {
    console.error("Error sending bundle to Jito:", (e as Error).message);
  }
};