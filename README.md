# $GakeAI Buyback Bot

Automated buyback bot that buys 0.01 SOL worth of $GakeAI every 20 seconds.

## Environment Variables

Set these in Railway:

```
DEV_WALLET_PK=your-wallet-private-key-base58
TOKEN_ADDRESS=your-token-mint-address
```

## Deploy

1. Push to GitHub
2. Connect to Railway
3. Add environment variables
4. Deploy!

## Local Dev

```bash
npm install
DEV_WALLET_PK=xxx TOKEN_ADDRESS=xxx node server.js
```
