import fs from 'fs';
import https from 'https';
import path from 'path';

const FILE = process.argv[2] || 'data/AllData.sqlite';
const URL = process.argv[3] || 'https://powerninedev-production.up.railway.app';
const TOKEN = process.argv[4] || process.env.DB_UPLOAD_TOKEN;
const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks

if (!TOKEN) {
    console.error('Usage: node scripts/upload-db.js [file] [url] [token]');
    console.error('Or set DB_UPLOAD_TOKEN env var');
    process.exit(1);
}

const fileSize = fs.statSync(FILE).size;
const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
console.log(`Uploading ${(fileSize / 1024 / 1024).toFixed(1)} MB in ${totalChunks} chunks of ${CHUNK_SIZE / 1024 / 1024}MB...`);

async function uploadChunk(chunkNum, start, end) {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(FILE, { start, end: end - 1 });
        const size = end - start;

        const url = new globalThis.URL(`${URL}/upload-db/${chunkNum}`);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'PUT',
            headers: {
                'x-upload-token': TOKEN,
                'Content-Type': 'application/octet-stream',
                'Content-Length': size
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (d) => body += d);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(body));
                } else {
                    reject(new Error(`Chunk ${chunkNum} failed (${res.statusCode}): ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(300000, () => { req.destroy(); reject(new Error(`Chunk ${chunkNum} timed out`)); });
        readStream.pipe(req);
    });
}

async function assemble() {
    return new Promise((resolve, reject) => {
        const url = new globalThis.URL(`${URL}/upload-db/assemble`);
        const req = https.request({
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: { 'x-upload-token': TOKEN },
            timeout: 600000
        }, (res) => {
            let body = '';
            res.on('data', (d) => body += d);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(JSON.parse(body));
                else reject(new Error(`Assemble failed (${res.statusCode}): ${body}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(600000, () => { req.destroy(); reject(new Error('Assemble timed out')); });
        req.end();
    });
}

async function main() {
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileSize);
        const pct = ((i + 1) / totalChunks * 100).toFixed(0);
        process.stdout.write(`  Chunk ${i + 1}/${totalChunks} (${pct}%)...`);
        const result = await uploadChunk(i, start, end);
        console.log(` ${(result.bytes / 1024 / 1024).toFixed(1)} MB OK`);
    }

    console.log('\nAssembling and verifying...');
    const result = await assemble();
    console.log(`Done! ${(result.size / 1024 / 1024).toFixed(1)} MB, integrity: ${result.integrity}`);
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
