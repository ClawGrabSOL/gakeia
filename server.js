const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3003;

// === CONFIGURATION ===
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || 'HAjZ2jbVaJXNSh5o5MQgFdHxZyf5MjDb3JwTSygyzPbF';
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || 'GhDJA35RjvZmPGGdydgt65nV3tvCsSKZvK6G4SBFpump';
const CHECK_INTERVAL = 10 * 1000; // Check every 10 seconds

// Stats
let stats = {
    totalBuybacks: 0,
    totalSol: 0,
    totalTokens: 0
};

let seenTxs = new Set();
let clients = new Set();

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(message);
        }
    });
}

// Fetch recent transactions from Helius (free Solana RPC with tx history)
async function fetchRecentTransactions() {
    try {
        // Use Solana RPC to get signatures
        const response = await fetch('https://api.mainnet-beta.solana.com', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [WALLET_ADDRESS, { limit: 10 }]
            })
        });
        
        const data = await response.json();
        
        if (!data.result) {
            console.log('No transactions found');
            return;
        }
        
        // Process new transactions
        for (const tx of data.result.reverse()) {
            if (seenTxs.has(tx.signature)) continue;
            seenTxs.add(tx.signature);
            
            // Skip if error
            if (tx.err) continue;
            
            console.log(`New TX: ${tx.signature}`);
            
            // Get transaction details
            const detailRes = await fetch('https://api.mainnet-beta.solana.com', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getTransaction',
                    params: [tx.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
                })
            });
            
            const detailData = await detailRes.json();
            
            if (!detailData.result) continue;
            
            // Try to extract swap info
            const meta = detailData.result.meta;
            if (!meta) continue;
            
            // Calculate SOL change (negative = spent)
            const preBalance = meta.preBalances[0] || 0;
            const postBalance = meta.postBalances[0] || 0;
            const solChange = (preBalance - postBalance) / 1e9;
            
            // Look for token changes
            let tokensReceived = 0;
            if (meta.postTokenBalances && meta.preTokenBalances) {
                for (const post of meta.postTokenBalances) {
                    if (post.mint === TOKEN_ADDRESS) {
                        const pre = meta.preTokenBalances.find(p => p.mint === TOKEN_ADDRESS);
                        const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmount || 0) : 0;
                        const postAmount = parseFloat(post.uiTokenAmount.uiAmount || 0);
                        tokensReceived = postAmount - preAmount;
                    }
                }
            }
            
            // Only count if it looks like a buyback (spent SOL, got tokens)
            if (solChange > 0.001 && tokensReceived > 0) {
                stats.totalBuybacks++;
                stats.totalSol += solChange;
                stats.totalTokens += tokensReceived;
                
                broadcast({
                    type: 'buyback',
                    txHash: tx.signature,
                    solSpent: solChange,
                    tokensReceived: tokensReceived
                });
                
                console.log(`✅ Buyback: ${solChange.toFixed(4)} SOL → ${tokensReceived} tokens`);
            }
        }
        
        // Keep seenTxs from growing too large
        if (seenTxs.size > 100) {
            const arr = Array.from(seenTxs);
            seenTxs = new Set(arr.slice(-50));
        }
        
    } catch (err) {
        console.error('Error fetching transactions:', err.message);
    }
}

// HTTP Server
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
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
    
    ws.send(JSON.stringify({ type: 'stats', ...stats }));
    ws.send(JSON.stringify({ 
        type: 'config', 
        tokenAddress: TOKEN_ADDRESS,
        walletAddress: WALLET_ADDRESS
    }));
    
    ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
    console.log(`\n🚀 $GakeAI Live Feed running at http://localhost:${PORT}`);
    console.log(`👛 Watching wallet: ${WALLET_ADDRESS}`);
    console.log(`🪙 Token: ${TOKEN_ADDRESS}\n`);
    
    // Start watching for transactions
    setInterval(fetchRecentTransactions, CHECK_INTERVAL);
    fetchRecentTransactions();
});
