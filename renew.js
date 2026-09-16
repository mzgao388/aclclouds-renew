const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');

const EMAIL = process.env.ACL_EMAIL;
const PASSWORD = process.env.ACL_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PROXY_URL = process.env.PROXY_URL;
// 2026-09: panel moved from dash.aclclouds.com to aclclouds.com with a new React UI
const BASE_URL = 'https://aclclouds.com';
// Local proxy tunnel created when PROXY_URL is set; reused so Telegram
// notifications also work from networks that block api.telegram.org.
let tgAgent = null;

async function notify(message, photoPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    if (photoPath) {
      const boundary = '----FB' + Math.random().toString(36).slice(2);
      const fileData = fs.readFileSync(photoPath);
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${message}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="err.png"\r\nContent-Type: image/png\r\n\r\n` + fileData.toString('binary') + `\r\n--${boundary}--\r\n`;
      await new Promise((resolve, reject) => {
        const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, agent: tgAgent || undefined }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('[TG] Photo sent'); resolve(d); }); });
        req.on('error', reject); req.write(body, 'binary'); req.end();
      });
      return;
    }
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' });
    await new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, agent: tgAgent || undefined }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('[TG] Notification sent'); resolve(d); }); });
      req.on('error', reject); req.write(body); req.end();
    });
  } catch (e) {
    console.log('[TG] notify failed: ' + e.message);
  }
}

function ocr(file) {
  return new Promise((resolve) => {
    execFile('tesseract', [file, 'stdout', '--psm', '7', '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'], (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z]/g, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function wordScore(ocrText, target) {
  const t = normalize(target);
  if (!t) return Infinity;
  const words = String(ocrText).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let best = Infinity;
  for (const w of words) {
    if (w === t) return 0;
    if (t.length > 2 && (w.includes(t) || t.includes(w))) best = Math.min(best, 1);
    best = Math.min(best, levenshtein(w, t));
  }
  return best;
}

// Preprocess the captcha option images inside the page (upscale + binarize + strip
// noise lines) — same pipeline verified against the live site.
async function collectCaptchaImages(page) {
  return page.evaluate(async () => {
    const challenge = document.querySelector('.auth-captcha-challenge');
    const target = challenge?.querySelector('strong')?.textContent?.trim()
      || (challenge?.innerText || '').replace(/^click on\s*/i, '').trim();
    const imgs = [...document.querySelectorAll('.auth-captcha-option-img')];
    const variants = [];
    for (const img of imgs) {
      const resp = await fetch(img.src, { credentials: 'include' });
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const scale = 4;
      const out = [];
      for (const th of [80, 120]) {
        const c = document.createElement('canvas');
        c.width = bmp.width * scale;
        c.height = bmp.height * scale;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const w = c.width, h = c.height, px = d.data;
        const bin = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const g = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
          bin[i] = g < th ? 0 : 255;
        }
        const frac = 0.5;
        for (let y = 0; y < h; y++) {
          let run = 0;
          for (let x = 0; x <= w; x++) {
            if (x < w && bin[y * w + x] === 0) run++;
            else { if (run > frac * w) for (let xx = x - run; xx < x; xx++) bin[y * w + xx] = 255; run = 0; }
          }
        }
        for (let x = 0; x < w; x++) {
          let run = 0;
          for (let y = 0; y <= h; y++) {
            if (y < h && bin[y * w + x] === 0) run++;
            else { if (run > frac * h) for (let yy = y - run; yy < y; yy++) bin[yy * w + x] = 255; run = 0; }
          }
        }
        for (let i = 0; i < w * h; i++) {
          const v = bin[i];
          px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
        }
        ctx.putImageData(d, 0, 0);
        out.push(c.toDataURL('image/png').split(',')[1]);
      }
      variants.push(out);
    }
    return { target, variants };
  });
}

// Solve the "Click on X" captcha. Returns {ok, needReload}: once the widget is
// in the "failed" state, re-clicking does nothing and the page must be reloaded.
async function solveCaptcha(page) {
  const boxClass = await page.evaluate(() => document.querySelector('.auth-captcha-box')?.className || '');
  if (boxClass.includes('failed')) return { ok: false, needReload: true };

  await page.locator('.auth-captcha-inner').first().click();
  try {
    await page.waitForSelector('.auth-captcha-challenge img', { timeout: 8000 });
  } catch {
    const verified = await page.evaluate(() => document.querySelector('.auth-captcha-box')?.className.includes('verified'));
    return { ok: !!verified, needReload: false };
  }
  await page.waitForTimeout(500);

  const { target, variants } = await collectCaptchaImages(page);
  console.log(`  Captcha target: "${target}"`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aclcap-'));
  const scores = variants.map(() => Infinity);
  for (let i = 0; i < variants.length; i++) {
    for (let v = 0; v < variants[i].length; v++) {
      const f = path.join(tmp, `o${i}_${v}.png`);
      fs.writeFileSync(f, Buffer.from(variants[i][v], 'base64'));
      const text = await ocr(f);
      const s = wordScore(text, target);
      if (s < scores[i]) scores[i] = s;
    }
  }
  console.log('  OCR scores: ' + scores.map(s => s.toFixed(2)).join(', '));

  const idx = scores.indexOf(Math.min(...scores));
  const box = await page.locator('.auth-captcha-option').nth(idx).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => document.querySelector('.auth-captcha-box')?.className || '');
  return { ok: state.includes('verified'), needReload: state.includes('failed') };
}

async function login(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[login] attempt ${attempt}`);
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.getByRole('textbox', { name: /email/i }).fill(EMAIL);
    await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD);
    const { ok } = await solveCaptcha(page);
    if (!ok) {
      console.log('  captcha not verified this round');
      continue;
    }
    console.log('  captcha verified, signing in...');
    await page.getByRole('button', { name: /sign in|connexion/i }).first().click();
    try {
      await page.waitForURL(/dashboard/, { timeout: 20000 });
      return true;
    } catch {}
    console.log('  still on: ' + page.url());
  }
  return false;
}

async function fetchServers(page) {
  try {
    return await page.evaluate(async () => {
      const r = await fetch('/api/client', { credentials: 'include' });
      const j = await r.json();
      if (j.errors) return [];
      return (j.data || []).map(s => {
        const a = s.attributes || {};
        return {
          identifier: a.identifier,
          name: a.name,
          can_renew: !!a.can_renew,
          expires_at: a.expires_at
        };
      });
    });
  } catch {
    return [];
  }
}

async function clickAllRenewButtons(page) {
  let clicked = 0;
  for (const route of ['/dashboard', '/dashboard/projects']) {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    for (const role of ['button', 'link']) {
      const loc = page.getByRole(role, { name: /renew|renouveler|rinnova|renovar/i });
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        try {
          await loc.nth(i).click({ timeout: 5000 });
          clicked++;
          console.log(`  clicked ${role} "Renew" (#${clicked})`);
          await page.waitForTimeout(3000);
          // handle a possible confirmation modal
          const confirmBtn = page.getByRole('button', { name: /^(confirm|yes|ok|confirmer|oui)$/i });
          if (await confirmBtn.count()) {
            await confirmBtn.first().click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(3000);
          }
        } catch (e) {
          console.log('  click failed: ' + e.message);
        }
      }
    }
  }
  return clicked;
}

(async () => {
  console.log('=== ACLClouds Auto-Renew ===');
  console.log(`Time: ${new Date().toISOString()}`);
  if (!EMAIL || !PASSWORD) {
    console.error('ACL_EMAIL / ACL_PASSWORD not set');
    process.exit(1);
  }

  let localProxyUrl = null;
  if (PROXY_URL) {
    console.log('[0] Starting proxy tunnel...');
    localProxyUrl = await anonymizeProxy(PROXY_URL);
    tgAgent = new (require('https-proxy-agent').HttpsProxyAgent)(localProxyUrl);
    console.log(`  Proxy: ${localProxyUrl} (browser + Telegram notifications)`);
  }

  const launchOptions = { headless: true };
  if (localProxyUrl) launchOptions.proxy = { server: localProxyUrl };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    const ok = await login(page);
    if (!ok) {
      const shot = path.join(os.tmpdir(), 'acl_login_error.png');
      await page.screenshot({ path: shot, fullPage: true });
      await notify('❌ ACLClouds 登录失败：连续 3 次未通过验证码或账号密码不对，请检查 Secrets 或稍后重试', shot);
      throw new Error('Login failed');
    }
    console.log('[OK] Logged in!');
    await page.waitForTimeout(2000);

    let servers = await fetchServers(page);
    if (!servers.length) {
      await notify('⚠️ ACLClouds：登录成功，但 /api/client 没有返回任何服务器');
      throw new Error('No servers returned by /api/client');
    }
    const before = new Map(servers.map(s => [s.identifier, s.can_renew]));
    console.log('Servers: ' + JSON.stringify(servers, null, 1));

    if (servers.some(s => s.can_renew)) {
      console.log('[renew] renewal available, looking for the Renew button...');
      const clicked = await clickAllRenewButtons(page);
      console.log(`[renew] clicked ${clicked} renew control(s)`);
      await page.waitForTimeout(2000);
      servers = await fetchServers(page);
    }

    const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '?';
    const left = (iso) => {
      if (!iso) return '?';
      const ms = new Date(iso) - Date.now();
      return `${Math.floor(ms / 86400000)}天${Math.floor((ms % 86400000) / 3600000)}小时`;
    };
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const lines = servers.map(s => {
      const exp = fmt(s.expires_at);
      if (before.get(s.identifier) && !s.can_renew) return `✅ ${s.name}：续期成功！新到期时间：${exp}`;
      if (s.can_renew) return `⚠️ ${s.name}：续期已开放但没找到续期按钮，请手动处理（剩余 ${left(s.expires_at)}，到期：${exp}）`;
      return `⏳ ${s.name}：还没到续期时间（剩余 ${left(s.expires_at)}，到期：${exp}；到期前 2 天开放）`;
    });
    await notify(`☁️ <b>ACLClouds 自动续期</b>\n⏰ ${now}\n\n${lines.join('\n')}`);
    console.log('=== Summary ===');
    lines.forEach(l => console.log(l));
    console.log('=== Done ===');
  } catch (err) {
    console.error('Error:', err.message);
    try {
      const shot = path.join(os.tmpdir(), 'acl_error.png');
      await page.screenshot({ path: shot, fullPage: true });
      await notify('❌ ACLClouds 自动续期出错：' + err.message, shot);
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
    if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl);
  }
})();
