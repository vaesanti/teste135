const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

// Configurações do Puzzle #73
const TARGET_PUBKEY_COMPRESSED = "02145d2611c823a396ef6712ce0f712f09b9b4f3135e3e0aa3230fb9b6d08d1e16";
const RANGE_START = BigInt("0x4000000000000000000000000000000000");
const RANGE_END = BigInt("0x7fffffffffffffffffffffffffffffffff");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let jaEnviouAlerta = false;

function sendAlert(privKey) {
    if (jaEnviouAlerta) return;
    jaEnviouAlerta = true;
    const message = `🚀 135: ${privKey}`;
    const cmd = `curl -s -X POST https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage -d chat_id=${TELEGRAM_CHAT_ID} -d text="${message}"`;
    exec(cmd, () => {
        console.log("\n✅ Alerta enviado!");
        setTimeout(() => process.exit(0), 5000);
    });
}

if (isMainThread) {
    // 1. LER O PROGRESSO SALVO NO GITHUB
    let currentStart;
    try {
        const saved = fs.readFileSync('last_key.txt', 'utf8').trim();
        currentStart = BigInt(saved.startsWith('0x') ? saved : '0x' + saved);
        console.log(`\x1b[32m[RETOMANDO]\x1b[0m Iniciando de: ${currentStart.toString(16)}`);
    } catch (e) {
        currentStart = RANGE_START;
        console.log(`\x1b[33m[INÍCIO]\x1b[0m Arquivo não encontrado, começando do zero.`);
    }

    const numCPUs = os.cpus().length;
    let totalChecked = 0;
    const startTime = Date.now();
    let lastKeyReached = currentStart;

    for (let i = 0; i < numCPUs; i++) {
        const worker = new Worker(__filename, { 
            workerData: { start: currentStart + BigInt(i), step: BigInt(numCPUs) } 
        });

        worker.on('message', (msg) => {
            if (msg.type === 'found') {
                sendAlert(msg.priv);
            }
            if (msg.type === 'stats') {
                totalChecked += msg.count;
                if (BigInt('0x' + msg.last) > lastKeyReached) {
                    lastKeyReached = BigInt('0x' + msg.last);
                }
                const elapsed = (Date.now() - startTime) / 1000;
                process.stdout.write(`\r> Speed: ${Math.floor(totalChecked / elapsed).toLocaleString()} k/s | Atual: ${msg.last}`);
            }
        });
    }

    // SALVAR NO ARQUIVO LOCAL ANTES DE SAIR (O workflow fará o PUSH depois)
    process.on('SIGTERM', () => {
        fs.writeFileSync('last_key.txt', lastKeyReached.toString(16));
        process.exit(0);
    });
    
    // Salva periodicamente para garantir
    setInterval(() => {
        fs.writeFileSync('last_key.txt', lastKeyReached.toString(16));
    }, 10000);

} else {
    const targetBuf = Buffer.from(TARGET_PUBKEY_COMPRESSED, 'hex');
    let currentKey = workerData.start;
    let batch = 0;

    while (currentKey <= RANGE_END) {
        const privHex = currentKey.toString(16).padStart(64, '0');
        try {
            const pubKey = secp256k1.publicKeyCreate(Buffer.from(privHex, 'hex'), true);
            if (Buffer.compare(pubKey, targetBuf) === 0) {
                parentPort.postMessage({ type: 'found', priv: privHex });
                break;
            }
        } catch (e) {}

        currentKey += workerData.step;
        batch++;

        if (batch >= 25000) {
            parentPort.postMessage({ type: 'stats', count: batch, last: privHex });
            batch = 0;
        }
    }
}
