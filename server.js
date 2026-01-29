const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3003;

// === CONFIGURATION ===
// IMPORTANT: Set these as environment variables in Railway, not in code!
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PK;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
const BUYBACK_INTERVAL = 20 * 1000; // 20 seconds
const BUYBACK_AMOUNT = 0.01; // Fixed 0.01 SOL per buyback

// Stats
let stats = {
    totalBuybacks: 0,
    totalSol: 0,
    totalTokens: 0
};

// WebSocket clients
const clients = new Set();

// Broadcast to all clients
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(message);
        }
    });
}

// ========================================
// SOLANA BUYBACK LOGIC
// ========================================
const { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

let wallet = null;
let walletPublicKey = null;

// Initialize wallet from private key
function initWallet() {
    try {
        if (DEV_WALLET_PRIVATE_KEY === 'YOUR_PRIVATE_KEY_HERE') {
            console.log('⚠️  No private key configured. Set DEV_WALLET_PK environment variable.');
            return false;
        }
        
        const secretKey = bs58.decode(DEV_WALLET_PRIVATE_KEY);
        wallet = Keypair.fromSecretKey(secretKey);
        walletPublicKey = wallet.publicKey.toString();
        console.log('✅ Wallet initialized:', walletPublicKey);
        return true;
    } catch (err) {
        console.error('❌ Failed to initialize wallet:', err.message);
        return false;
    }
}

// Get wallet SOL balance
async function getWalletBalance() {
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        return balance / 1e9; // Convert lamports to SOL
    } catch (err) {
        console.error('Error getting balance:', err.message);
        return 0;
    }
}

// Execute buyback via Jupiter
async function executeBuyback(solAmount) {
    try {
        console.log(`🔄 Executing buyback: ${solAmount} SOL → $GakeAI`);
        
        const lamports = Math.floor(solAmount * 1e9);
        
        // Get Jupiter quote
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${TOKEN_ADDRESS}&amount=${lamports}&slippageBps=100`;
        
        const quoteRes = await fetch(quoteUrl);
        const quote = await quoteRes.json();
        
        if (!quote || quote.error) {
            console.error('Quote error:', quote?.error || 'No quote');
            return null;
        }
        
        const outputAmount = parseInt(quote.outAmount) / 1e6; // Assuming 6 decimals
        console.log(`📊 Quote: ${solAmount} SOL → ${outputAmount} tokens`);
        
        // Get swap transaction
        const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quote,
                userPublicKey: walletPublicKey,
                wrapAndUnwrapSol: true,
            })
        });
        
        const swapData = await swapRes.json();
        
        if (!swapData.swapTransaction) {
            console.error('Swap error:', swapData.error || 'No transaction');
            return null;
        }
        
        // Deserialize and sign transaction
        const swapTxBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(swapTxBuf);
        tx.sign([wallet]);
        
        // Send transaction
        const txHash = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3
        });
        
        console.log(`✅ Buyback TX: ${txHash}`);
        
        // Wait for confirmation
        await connection.confirmTransaction(txHash, 'confirmed');
        
        return {
            txHash,
            solSpent: solAmount,
            tokensReceived: outputAmount
        };
        
    } catch (err) {
        console.error('❌ Buyback failed:', err.message);
        return null;
    }
}

// Main buyback loop
async function buybackLoop() {
    if (!wallet) {
        console.log('Wallet not initialized, skipping buyback');
        return;
    }
    
    try {
        const balance = await getWalletBalance();
        console.log(`💰 Wallet balance: ${balance.toFixed(4)} SOL`);
        
        // Need enough for buyback + fees
        const minRequired = BUYBACK_AMOUNT + 0.005;
        
        if (balance >= minRequired) {
            const result = await executeBuyback(BUYBACK_AMOUNT);
            
            if (result) {
                stats.totalBuybacks++;
                stats.totalSol += result.solSpent;
                stats.totalTokens += result.tokensReceived;
                
                // Broadcast to website
                broadcast({
                    type: 'buyback',
                    ...result
                });
                
                console.log(`📈 Total buybacks: ${stats.totalBuybacks} | SOL spent: ${stats.totalSol.toFixed(4)}`);
            }
        } else {
            console.log(`⏳ Need ${minRequired.toFixed(3)} SOL, have ${balance.toFixed(4)} SOL`);
        }
    } catch (err) {
        console.error('Buyback loop error:', err.message);
    }
}

// ========================================
// HTTP & WEBSOCKET SERVER
// ========================================

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
};

const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    filePath = path.join(__dirname, 'public', filePath);
    
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`Client connected. Total: ${clients.size}`);
    
    // Send current stats
    ws.send(JSON.stringify({ type: 'stats', ...stats }));
    
    // Send config
    ws.send(JSON.stringify({ 
        type: 'config', 
        tokenAddress: TOKEN_ADDRESS,
        walletAddress: walletPublicKey
    }));
    
    ws.on('close', () => {
        clients.delete(ws);
    });
});

// ========================================
// START
// ========================================

server.listen(PORT, () => {
    console.log(`\n🚀 $GakeAI Buyback Bot running at http://localhost:${PORT}\n`);
    
    const walletOk = initWallet();
    
    if (walletOk && TOKEN_ADDRESS !== 'YOUR_TOKEN_MINT_ADDRESS') {
        console.log(`🪙 Token: ${TOKEN_ADDRESS}`);
        console.log(`⏱️  Buyback interval: ${BUYBACK_INTERVAL / 1000} seconds\n`);
        
        // Start buyback loop
        setInterval(buybackLoop, BUYBACK_INTERVAL);
        
        // Run first buyback after 5 seconds
        setTimeout(buybackLoop, 5000);
    } else {
        console.log('⚠️  Configure TOKEN_ADDRESS and DEV_WALLET_PK to enable buybacks\n');
    }
});
