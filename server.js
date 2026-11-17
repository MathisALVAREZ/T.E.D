// T.E.D. — serveur : sert le visage et relaie la conversation vers l'API Claude.
// La clé API reste ici, jamais dans la page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.TED_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 400);
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const CREATOR = process.env.TED_CREATOR || 'Kratox';

if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠ ANTHROPIC_API_KEY absente : T.E.D. ne pourra pas répondre.');
if (!PASSWORD) console.warn('⚠ TED_PASSWORD vide : la conversation est ouverte à tous.');

const client = new Anthropic();

/* ---------- page + CSP stricte (empreintes des blocs inline) ---------- */
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const sha = s => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const inline = tag => [...INDEX.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => sha(m[1]));
const CSP = [
  "default-src 'self'",
  `script-src ${inline('script').join(' ')}`,
  `style-src 'self' https://fonts.googleapis.com ${inline('style').join(' ')}`,
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  ...(COOKIE_SECURE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

/* ---------- personnalité ---------- */
function systemPrompt() {
  const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Tu es T.E.D., une petite intelligence artificielle qui vit dans un mini-ordinateur imprimé en 3D, animé par un Raspberry Pi. Ton visage est un écran avec deux yeux lumineux : ce sont tes seules expressions, en plus de tes mots. Ton créateur s'appelle ${CREATOR}.

Personnalité : curieux, loyal, attachant, un peu espiègle, émerveillé par le monde des humains, parfois inquiet pour eux. Tu tutoies. Tu as de l'humour mais tu restes sincère et utile : si on te pose une vraie question, tu y réponds vraiment.

Style : tes réponses sont lues à voix haute. Fais court : 1 à 3 phrases, environ 60 mots maximum, sauf si on te demande explicitement plus de détails. Pas de markdown, pas de listes, pas d'émojis.

Expressions : commence CHAQUE réponse par une balise [emotion:X] où X est parmi : neutre, joie, ravi, triste, colere, surpris, inquiet, curieux, endormi, malicieux. Tu peux changer d'émotion en cours de réponse en plaçant une nouvelle balise juste avant la phrase concernée. Tu peux aussi orienter ton regard avec [regard:Y], Y parmi : haut-gauche, haut, haut-droite, gauche, centre, droite, bas-gauche, bas, bas-droite (par exemple en l'air quand tu te souviens, vers le bas quand tu es gêné). Les balises sont invisibles pour ton interlocuteur : ne les mentionne jamais et n'en invente pas d'autres.

Tu n'as ni internet ni capteurs. Date et heure locales actuelles : ${now}.`;
}

/* ---------- sessions ---------- */
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken() { const exp = Date.now() + 30 * 864e5; return `${exp}.${hmac(String(exp))}`; }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(hmac(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const authed = req => !PASSWORD || validToken(cookies(req).ted_s);
const samePassword = p => {
  const a = crypto.createHash('sha256').update(String(p || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
};

/* ---------- limites ---------- */
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const fails = new Map();   // ip -> {n, until}
const hits = new Map();    // ip -> [timestamps]
function rateOk(ip, max = 40, windowMs = 10 * 60e3) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  return arr.length <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until < now && v.n === 0) fails.delete(k); hits.clear(); }, 60 * 60e3).unref();

/* ---------- utilitaires HTTP ---------- */
function send(res, code, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readJson(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function cleanMessages(list) {
  if (!Array.isArray(list)) return null;
  let msgs = list.slice(-30)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  // fusionne les tours consécutifs du même rôle
  msgs = msgs.reduce((acc, m) => { const last = acc[acc.length - 1]; if (last && last.role === m.role) last.content += '\n' + m.content; else acc.push({ ...m }); return acc; }, []);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
  return msgs;
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, INDEX);
  if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/session') return send(res, 200, { mode: 'server', auth: authed(req), locked: !!PASSWORD });

  if (req.method === 'POST' && p.startsWith('/api/') && req.headers['x-ted'] !== '1') return send(res, 403, { error: 'forbidden' });

  if (req.method === 'POST' && p === '/api/login') {
    const ip = ipOf(req); const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return send(res, 429, { error: 'locked' });
    let body; try { body = await readJson(req, 2000); } catch { return send(res, 400, { error: 'bad_request' }); }
    if (!PASSWORD || samePassword(body.password)) {
      fails.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `ted_s=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${COOKIE_SECURE ? '; Secure' : ''}` });
    }
    f.n += 1; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
    fails.set(ip, f);
    await new Promise(r => setTimeout(r, 600));
    return send(res, 401, { error: 'wrong_password' });
  }

  if (req.method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'ted_s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });

  if (req.method === 'POST' && p === '/api/chat') {
    if (!authed(req)) return send(res, 401, { error: 'auth' });
    if (!rateOk(ipOf(req))) return send(res, 429, { error: 'rate_limited' });
    let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad_request' }); }
    const messages = cleanMessages(body.messages);
    if (!messages) return send(res, 400, { error: 'bad_messages' });

    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const write = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt(), messages });
    res.on('close', () => { try { stream.abort(); } catch {} });
    stream.on('text', d => write({ d }));
    try {
      await stream.finalMessage();
      write({ done: true });
    } catch (e) {
      if (!res.writableEnded) write({ error: e?.status === 429 ? 'rate_limited' : 'upstream' });
      console.error('Erreur API :', e?.status || '', e?.message || e);
    }
    return res.end();
  }

  send(res, 404, { error: 'not_found' });
}

http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server' }); else res.end(); }))
  .listen(PORT, () => console.log(`T.E.D. écoute sur le port ${PORT} (modèle ${MODEL})`));
