import { Connection, PublicKey, TransactionSignature } from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { OpenOrders } from "@project-serum/serum";
import { getSolBalance, POOL, OPENBOOK_PROGRAM_ID, wallet, mintCA } from "./config";
import { swapTokens } from './trade';

const TRADE_AMOUNT = 1000000000;
const BUY_DROP_PERCENT = 14;
const SELL_RISE_PERCENT = 6;
const STOP_LOSS_PERCENT = 8;
const POLLING_INTERVAL = 100;
const PRICE_CONFIRMATION_TICKS = 2;
const PRICE_CONFIRMATION_THRESHOLD = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  lastHigh: undefined as number | undefined,
  lastLow: undefined as number | undefined,
  entryPrice: null as number | null,
  pendingSell: {
    active: false,
    targetPrice: 0,
    ticksCount: 0,
  },
};

const connection = new Connection("http://nyc.rpc.gadflynode.com:80", "confirmed");

const waitForConfirmation = async (connection: Connection, signature: TransactionSignature) => {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    blockhash,
    lastValidBlockHeight,
    signature,
  }, "confirmed");
  console.log("Транзакция подтверждена:", signature);
};


const executeTrade = async (action: "buy" | "sell", tokenPrice: number) => {
  try {
    const signature = await swapTokens({
      action,
      mintCA,
      amount: TRADE_AMOUNT,
    });
    if (action === "buy") {
      await sleep(1500)
    }

    console.log(`${action === "buy" ? "Куплено" : "Продано"} по цене $${tokenPrice}, новый баланс: ${getSolBalance(wallet)}`);

    state.entryPrice = action === "buy" ? tokenPrice : null;
    state.lastHigh = tokenPrice;
    state.lastLow = tokenPrice;
  } catch (error) {
    console.error(`Ошибка при выполнении ${action}:`, error);
  }
};


const getPoolInfo = async (connection: Connection) => {
  const info = await connection.getAccountInfo(new PublicKey(POOL));
  if (!info) return null;

  const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);
  const openOrders = await OpenOrders.load(
    connection,
    poolState.openOrders,
    OPENBOOK_PROGRAM_ID
  );

  const baseDecimal = 10 ** poolState.baseDecimal.toNumber();
  const quoteDecimal = 10 ** poolState.quoteDecimal.toNumber();

  const [baseTokenAmount, quoteTokenAmount] = await Promise.all([
    connection.getTokenAccountBalance(poolState.baseVault),
    connection.getTokenAccountBalance(poolState.quoteVault),
  ]);

  const basePnl = poolState.baseNeedTakePnl.toNumber() / baseDecimal;
  const quotePnl = poolState.quoteNeedTakePnl.toNumber() / quoteDecimal;

  const openOrdersBaseTokenTotal = openOrders.baseTokenTotal.toNumber() / baseDecimal;
  const openOrdersQuoteTokenTotal = openOrders.quoteTokenTotal.toNumber() / quoteDecimal;

  const base = (baseTokenAmount.value?.uiAmount || 0) + openOrdersBaseTokenTotal - basePnl;
  const quote = (quoteTokenAmount.value?.uiAmount || 0) + openOrdersQuoteTokenTotal - quotePnl;
  const tokenPrice = parseFloat((base / quote).toFixed(8));

  return { tokenPrice, poolState, openOrders };
};


const parsePoolInfo = async () => {
  while (true) {
    try {
      const poolInfo = await getPoolInfo(connection);
      if (!poolInfo) continue;

      const { tokenPrice } = poolInfo;
      console.log(`Цена токена: $${tokenPrice}`);

      if (state.lastHigh === undefined) state.lastHigh = tokenPrice;
      if (state.lastLow === undefined) state.lastLow = tokenPrice;

      if (state.pendingSell.active) {
        const priceDiff = Math.abs((tokenPrice - state.pendingSell.targetPrice) / state.pendingSell.targetPrice * 100);
        
        if (priceDiff <= PRICE_CONFIRMATION_THRESHOLD) {
          state.pendingSell.ticksCount++;
          
          if (state.pendingSell.ticksCount >= PRICE_CONFIRMATION_TICKS) {
            await executeTrade("sell", tokenPrice);
            state.pendingSell.active = false;
          }
        } else {
          console.log("Ложный скачок цены. Отмена продажи.");
          state.pendingSell.active = false;
        }
      }

      if (!state.entryPrice && tokenPrice <= state.lastHigh * (1 - BUY_DROP_PERCENT / 100)) {
        await executeTrade("buy", tokenPrice);
      }

      if (state.entryPrice && !state.pendingSell.active) {
        if (tokenPrice <= state.entryPrice * (1 - STOP_LOSS_PERCENT / 100)) {
          await executeTrade("sell", tokenPrice);
          console.log(`Стоп-лосс сработал!`);
          state.lastHigh === undefined;
          await sleep(5000);
        }

        else if (tokenPrice >= state.entryPrice * (1 + SELL_RISE_PERCENT / 100)) {
          state.pendingSell = {
            active: true,
            targetPrice: tokenPrice,
            ticksCount: 0
          };
          console.log(`Обнаружен скачок цены. Начинаем подтверждение...`);
        }
      }

      await sleep(POLLING_INTERVAL);
    } catch (error) {
      console.error("Ошибка при анализе пула:", error);
      await sleep(POLLING_INTERVAL);
    }
  }
};



parsePoolInfo();