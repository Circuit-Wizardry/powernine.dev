import fs from 'fs';
import https from 'https';

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
console.log(`Chunks append directly to AllData.sqlite — no extra disk space needed.\n`);

function postEndpoint(endpoint, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const url = new globalThis.URL(`${URL}${endpoint}`);
        const req = https.request({
            hostname: url.hostname, port: 443, path: url.pathname,
            method: 'POST',
            headers: { 'x-upload-token': TOKEN },
            timeout: timeoutMs
        }, (res) => {
            let body = '';
            res.on('data', (d) => body += d);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(JSON.parse(body));
                else reject(new Error(`${endpoint} failed (${res.statusCode}): ${body}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`${endpoint} timed out`)); });
        req.end();
    });
}

function uploadChunk(chunkNum, start, end) {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(FILE, { start, end: end - 1 });
        const size = end - start;
        const url = new globalThis.URL(`${URL}/upload-db/${chunkNum}`);
        const req = https.request({
            hostname: url.hostname, port: 443, path: url.pathname,
            method: 'PUT',
            headers: {
                'x-upload-token': TOKEN,
                'Content-Type': 'application/octet-stream',
                'Content-Length': size
            }
        }, (res) => {
            let body = '';
            res.on('data', (d) => body += d);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(JSON.parse(body));
                else reject(new Error(`Chunk ${chunkNum} failed (${res.statusCode}): ${body}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(300000, () => { req.destroy(); reject(new Error(`Chunk ${chunkNum} timed out`)); });
        readStream.pipe(req);
    });
}

async function main() {
    // Step 1: Clean volume
    console.log('Cleaning volume...');
    const cleaned = await postEndpoint('/upload-db/clean');
    console.log(`Deleted ${cleaned.deleted.length} files: ${cleaned.deleted.join(', ') || '(none)'}\n`);

    // Step 2: Upload chunks (each appends directly to AllData.sqlite)
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileSize);
        const pct = ((i + 1) / totalChunks * 100).toFixed(0);
        process.stdout.write(`  Chunk ${i + 1}/${totalChunks} (${pct}%)...`);
        const result = await uploadChunk(i, start, end);
        console.log(` +${(result.bytes / 1024 / 1024).toFixed(1)} MB (total: ${(result.totalSize / 1024 / 1024).toFixed(1)} MB)`);
    }

    // Step 3: Verify integrity
    console.log('\nVerifying database integrity...');
    const result = await postEndpoint('/upload-db/verify', 600000);
    console.log(`Done! ${(result.size / 1024 / 1024).toFixed(1)} MB, integrity: ${result.integrity}`);
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
