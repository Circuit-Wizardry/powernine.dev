import https from 'https';
import os from 'os';

const DEFAULT_IP_LOOKUP_URL = process.env.DYN_IP_LOOKUP_URL || 'https://api.ipify.org?format=json';
const DEFAULT_UPDATE_URL = process.env.DYN_UPDATE_URL || 'https://members.dyndns.org/nic/update';

const request = (url, options = {}) => new Promise((resolve, reject) => {
    const requestOptions = {
        ...options,
    };
    const req = https.request(url, requestOptions, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ body: data, statusCode: res.statusCode });
            } else {
                const error = new Error(`Request to ${url} failed with status ${res.statusCode}: ${data}`);
                error.statusCode = res.statusCode;
                reject(error);
            }
        });
    });
    req.on('error', reject);
    if (options.body) {
        req.write(options.body);
    }
    req.end();
});

const isPrivateIpv4 = (address) => {
    if (!address) return false;
    if (address.startsWith('10.')) return true;
    if (address.startsWith('192.168.')) return true;
    if (address.startsWith('172.')) {
        const second = parseInt(address.split('.')[1], 10);
        if (Number.isFinite(second)) {
            return second >= 16 && second <= 31;
        }
    }
    return false;
};

const parsePreferredInterfaces = () => {
    const raw = process.env.DYN_INTERFACE;
    if (!raw) return [];
    return raw.split(',').map(name => name.trim()).filter(Boolean);
};

const collectInterfaceAddresses = (interfaces, ifaceName) => {
    const entries = interfaces[ifaceName];
    if (!entries) return [];
    return entries
        .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
        .map(entry => ({ name: ifaceName, address: entry.address }));
};

const getLocalIpv4 = () => {
    const preferredInterfaces = parsePreferredInterfaces();
    const interfaces = os.networkInterfaces();

    const normalize = (value) => value.toLowerCase();

    if (preferredInterfaces.length > 0) {
        for (const preference of preferredInterfaces) {
            const target = normalize(preference);
            const exactMatch = Object.keys(interfaces).find(name => normalize(name) === target);
            if (exactMatch) {
                const matches = collectInterfaceAddresses(interfaces, exactMatch);
                if (matches.length > 0) return matches[0].address;
            }
            const partialMatch = Object.keys(interfaces).find(name => normalize(name).includes(target));
            if (partialMatch) {
                const matches = collectInterfaceAddresses(interfaces, partialMatch);
                if (matches.length > 0) return matches[0].address;
            }
        }
    }

    for (const name of Object.keys(interfaces)) {
        const matches = collectInterfaceAddresses(interfaces, name);
        if (matches.length > 0) return matches[0].address;
    }

    return null;
};

const getExternalIp = async () => {
    const { body } = await request(DEFAULT_IP_LOOKUP_URL, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'powernine.dev-dyndns/1.0',
        },
    });
    try {
        const payload = JSON.parse(body);
        if (!payload.ip) {
            throw new Error('IP lookup response did not include an ip field.');
        }
        return payload.ip;
    } catch (error) {
        throw new Error(`Failed to parse IP lookup response: ${error.message}`);
    }
};

const resolveTargetIp = async () => {
    if (process.env.DYN_USE_EXTERNAL_IP === 'true') {
        return getExternalIp();
    }
    const localIp = getLocalIpv4();
    if (!localIp) {
        if (process.env.DYN_FALLBACK_TO_EXTERNAL === 'true') {
            return getExternalIp();
        }
        throw new Error('Unable to determine a private IPv4 address for this host.');
    }
    return localIp;
};

const sendDynUpdate = async ({ hostname, username, password, ip }) => {
    const updateUrl = new URL(DEFAULT_UPDATE_URL);
    updateUrl.searchParams.set('hostname', hostname);
    if (ip) {
        updateUrl.searchParams.set('myip', ip);
    }

    const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

    const { body } = await request(updateUrl.toString(), {
        method: 'GET',
        headers: {
            'Authorization': `Basic ${auth}`,
            'User-Agent': 'powernine.dev-dyndns/1.0',
            'Accept': 'text/plain',
        },
    });

    return body.trim();
};

export const updateDynDns = async (logger = console) => {
    const hostname = process.env.DYN_HOSTNAME;
    const username = process.env.DYN_USERNAME;
    const password = process.env.DYN_PASSWORD || process.env.DYN_TOKEN;

    if (!hostname || !username || !password) {
        logger.warn('[DynDNS] Skipping update: DYN_HOSTNAME, DYN_USERNAME, and DYN_PASSWORD (or DYN_TOKEN) must be set.');
        return;
    }

    try {
        const ip = await resolveTargetIp();
        const response = await sendDynUpdate({ hostname, username, password, ip });
        logger.log(`[DynDNS] Update response for ${hostname}: ${response}`);
    } catch (error) {
        logger.error('[DynDNS] Failed to update DNS:', error);
    }
};

export const startDynDnsUpdater = ({ intervalMinutes, logger = console } = {}) => {
    const envInterval = process.env.DYN_UPDATE_INTERVAL_MINUTES;
    let interval = intervalMinutes;
    if (!Number.isFinite(interval) || interval <= 0) {
        interval = envInterval !== undefined ? parseFloat(envInterval) : 30;
    }
    const updateAndLog = () => updateDynDns(logger);

    updateAndLog();

    if (Number.isFinite(interval) && interval > 0) {
        const intervalMs = interval * 60 * 1000;
        setInterval(updateAndLog, intervalMs);
        logger.log(`[DynDNS] Scheduled updates every ${interval} minute(s).`);
    } else {
        logger.log('[DynDNS] Periodic updates disabled (no interval specified).');
    }
};
