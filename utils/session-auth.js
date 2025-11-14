import crypto from 'crypto';
import express from 'express';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'pn_session';
const SESSION_MINUTES = parseFloat(process.env.SESSION_DURATION_MINUTES) || 12 * 60;
const SESSION_MAX_AGE = SESSION_MINUTES * 60 * 1000;

const parseCookies = (cookieHeader) => {
    if (!cookieHeader) return {};
    return cookieHeader.split(';').reduce((acc, part) => {
        const [key, ...rest] = part.trim().split('=');
        if (!key) return acc;
        const value = rest.join('=');
        acc[key] = decodeURIComponent(value);
        return acc;
    }, {});
};

const serializeCookie = (name, value, options = {}) => {
    const segments = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) {
        segments.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
    }
    if (options.httpOnly !== false) {
        segments.push('HttpOnly');
    }
    if (options.sameSite) {
        segments.push(`SameSite=${options.sameSite}`);
    } else {
        segments.push('SameSite=Lax');
    }
    if (options.secure) {
        segments.push('Secure');
    }
    if (options.path) {
        segments.push(`Path=${options.path}`);
    } else {
        segments.push('Path=/');
    }
    return segments.join('; ');
};

const shouldUseSecureCookies = () => {
    if (process.env.SESSION_COOKIE_SECURE === 'true') return true;
    if (process.env.SESSION_COOKIE_SECURE === 'false') return false;
    return process.env.NODE_ENV === 'production';
};

export const createSessionAuth = ({ username, password }) => {
    if (!username || !password) {
        throw new Error('APP_USER and APP_PASSWORD must be configured for session authentication.');
    }

    const sessions = new Map(); // token -> { username, expiresAt }
    const router = express.Router();
    const secureCookies = shouldUseSecureCookies();
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [token, session] of sessions.entries()) {
            if (session.expiresAt < now) {
                sessions.delete(token);
            }
        }
    }, Math.min(SESSION_MAX_AGE, 15 * 60 * 1000));

    const disposeCleanup = () => clearInterval(cleanupInterval);
    process.once('exit', disposeCleanup);
    process.once('SIGINT', disposeCleanup);
    process.once('SIGTERM', disposeCleanup);

    const setSessionCookie = (res, token) => {
        const cookie = serializeCookie(COOKIE_NAME, token, {
            maxAge: SESSION_MAX_AGE,
            secure: secureCookies,
        });
        res.setHeader('Set-Cookie', cookie);
    };

    const clearSessionCookie = (res) => {
        const cookie = serializeCookie(COOKIE_NAME, '', {
            maxAge: 0,
            secure: secureCookies,
        });
        res.setHeader('Set-Cookie', cookie);
    };

    const createSession = (user) => {
        const token = crypto.randomUUID();
        sessions.set(token, {
            username: user,
            expiresAt: Date.now() + SESSION_MAX_AGE,
        });
        return token;
    };

    const getSessionFromRequest = (req) => {
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[COOKIE_NAME];
        if (!token) return null;
        const session = sessions.get(token);
        if (!session) return null;
        if (session.expiresAt < Date.now()) {
            sessions.delete(token);
            return null;
        }
        return { token, ...session };
    };

    const refreshSession = (token) => {
        const session = sessions.get(token);
        if (!session) return;
        session.expiresAt = Date.now() + SESSION_MAX_AGE;
        sessions.set(token, session);
    };

    const attachSession = (req, res, next) => {
        const session = getSessionFromRequest(req);
        if (session) {
            req.user = { username: session.username };
            refreshSession(session.token);
            setSessionCookie(res, session.token);
        }
        next();
    };

    const requireAuth = (req, res, next) => {
        if (req.user) {
            return next();
        }

        const accept = req.headers.accept || '';
        if (accept.includes('text/html')) {
            const nextParam = encodeURIComponent(req.originalUrl || '/');
            return res.redirect(`/login?next=${nextParam}`);
        }

        res.status(401).json({ error: 'Authentication required.' });
    };

    const renderLogin = (res, options = {}) => {
        const { error, nextPath } = options;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Login &mdash; powernine.dev</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #10121a; color: #f0f3ff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: rgba(24, 28, 40, 0.85); border: 1px solid rgba(120, 130, 160, 0.25); border-radius: 12px; padding: 32px; width: min(360px, 90vw); box-shadow: 0 24px 48px rgba(0,0,0,0.35); }
    h1 { margin: 0 0 16px; font-size: 1.6rem; text-align: center; }
    form { display: flex; flex-direction: column; gap: 16px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 0.95rem; }
    input { border-radius: 8px; border: 1px solid rgba(130,140,170,0.4); padding: 10px 12px; background: rgba(14, 16, 26, 0.9); color: inherit; font-size: 1rem; }
    input:focus { outline: none; border-color: #4fd1c5; box-shadow: 0 0 0 2px rgba(79,209,197,0.2); }
    button { background: #4fd1c5; color: #10121a; border: none; border-radius: 8px; padding: 12px; font-weight: 600; cursor: pointer; transition: background 0.2s ease; }
    button:hover { background: #38b2ac; }
    .error { color: #f87171; font-size: 0.9rem; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${nextPath ?? '/'}">
      <label>
        Username
        <input type="text" name="username" autocomplete="username" required>
      </label>
      <label>
        Password
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`);
    };

    router.get('/', (req, res) => {
        if (req.user) {
            const nextPath = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
            return res.redirect(nextPath);
        }
        const nextPath = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
        renderLogin(res, { nextPath });
    });

    router.post('/', (req, res) => {
        const { username: providedUser, password: providedPassword, next: nextPathRaw } = req.body || {};
        const nextPath = typeof nextPathRaw === 'string' && nextPathRaw.startsWith('/') ? nextPathRaw : '/';

        if (providedUser === username && providedPassword === password) {
            const token = createSession(providedUser);
            setSessionCookie(res, token);
            return res.redirect(nextPath || '/');
        }

        renderLogin(res, { error: 'Invalid username or password.', nextPath });
    });

    const logoutRouter = express.Router();
    logoutRouter.post('/', (req, res) => {
        const session = getSessionFromRequest(req);
        if (session) {
            sessions.delete(session.token);
        }
        clearSessionCookie(res);
        res.redirect('/login');
    });

    return {
        attachSession,
        requireAuth,
        loginRouter: router,
        logoutRouter,
    };
};
