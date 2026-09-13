/**
 * nextthuxk 通道（2026-09-13 深夜移植）：忠实复刻 NextTHUxk-server（美国服务器
 * 生产验证）的语义——平铺 cookie 罐（name→value 全发）、手动跟跳、GBK 字节
 * 解码、直连 id 双轮 CAS、落地 URL 自适应（webvpn 包装 base 或直连）。
 * 零引擎、零分桶、零包装规则——服务器只读自己要的 cookie，多发无害。
 */
import { parseCasFormHtml } from "../auth/cas.js";
import { decodeUrl } from "../crypto/webvpn.js";
import { encryptPassword } from "../crypto/sm2.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ZHJWXK = "https://zhjwxk.cic.tsinghua.edu.cn";
const ID_CHECK = "https://id.tsinghua.edu.cn/do/off/ui/auth/login/check";

export interface NtSession {
  jar: Record<string, string>;
  base: string;
  finalLandingUrl: string;
}

function gbkDecode(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buf);
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("gbk") || ct.includes("gb2312")) return new TextDecoder("gbk").decode(bytes);
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, 800));
  if (/charset=gbk|charset=gb2312/i.test(head)) return new TextDecoder("gbk").decode(bytes);
  if (/zhjwxk|xkBks|xklogin/i.test(head) || ct.includes("text/html")) {
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      /* 非 gbk 内容回退 utf8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export class Nt {
  jar: Record<string, string> = {};
  log?: (m: string) => void;
  /** WebView 内必须注入 tauriFetch（裸 fetch 会 CORS/混合内容拦截） */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch.bind(globalThis);
  cookieHeader(): string {
    return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  save(res: Response): void {
    const raw = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const c of raw) {
      const eq = c.indexOf("=");
      const semi = c.indexOf(";");
      if (eq > 0) this.jar[c.slice(0, eq).trim()] = c.slice(eq + 1, semi < 0 ? undefined : semi).trim();
    }
  }
  /** 手动跟跳（302/307/308），每跳收 set-cookie */
  async follow(url: string, maxHops = 15): Promise<{ finalUrl: string; res: Response; text: string }> {
    let cur = url;
    for (let i = 0; i < maxHops; i++) {
      this.log?.(`[NT-HOP] GET ${cur.slice(0, 90)}`);
      const res = await this.fetchImpl(cur, { redirect: "manual", headers: { "User-Agent": UA, Cookie: this.cookieHeader() } });
      this.save(res);
      if ([301, 302, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location") ?? "";
        if (!loc) return { finalUrl: cur, res, text: "" };
        cur = loc.startsWith("http") ? loc : new URL(loc, cur).href;
        continue;
      }
      const buf = await res.arrayBuffer();
      return { finalUrl: cur, res, text: gbkDecode(buf, res.headers.get("content-type")) };
    }
    throw new Error("nextthuxk: 跟跳超限（15）");
  }
  async postForm(url: string, form: Record<string, string>): Promise<{ finalUrl: string; res: Response; text: string }> {
    const body = Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const res = await this.fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { "User-Agent": UA, Cookie: this.cookieHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    this.save(res);
    const buf = await res.arrayBuffer();
    return { finalUrl: url, res, text: gbkDecode(buf, res.headers.get("content-type")) };
  }
}

/**
 * 选课会话建立（NextTHUxk-server finishLogin 同款，第二轮 CAS）：
 * 直连 xklogin.do → id CAS 表单（sm2publicKey）→ 直连 id check →
 * 登录成功 → 锚点落地 → 提取包装 base（若落地 webvpn）。
 * jar 预置 app 既有 webvpn/id 会话（平铺合并，id 最后写=其 JSESSIONID 胜出）。
 */
export async function nextthuxkLogin(opts: {
  username: string;
  password: string;
  fingerprint: string;
  seedCookies: Array<{ name: string; value: string }>;
  debug?: (m: string) => void;
}): Promise<NtSession> {
  const nt = new Nt();
  nt.log = opts.debug;
  for (const c of opts.seedCookies) nt.jar[c.name] = c.value;
  nt.log?.(`[NT] 平铺种子 ${Object.keys(nt.jar).length} cookies`);

  // ① 直连选课入口（NextTHUxk：webvpnZhjwxkBase 为空时直连 ZHJWXK）
  const home = await nt.follow(ZHJWXK + "/xklogin.do");
  nt.log?.(`[NT] xklogin final=${home.finalUrl.slice(0, 80)} len=${home.text.length}`);
  if (home.text.includes("清华大学WebVPN") && !home.finalUrl.includes("webvpn")) {
    throw new Error("nextthuxk: 入口被 webvpn 劫持");
  }
  // ② 解析 id CAS 表单（第二轮 SM2 钥匙）
  const form = parseCasFormHtml(home.text, false);
  const enc = encryptPassword(opts.password, form.publicKey);
  // ③ 直连 id check（平铺罐全发）
  const cr = await nt.postForm(ID_CHECK, {
    ...form.hiddenFields,
    i_user: opts.username,
    i_pass: enc,
    sm2pass: enc,
    fingerPrint: opts.fingerprint,
    fingerGenPrint: "",
    fingerGenPrint3: "",
    i_captcha: "",
  });
  nt.log?.(`[NT] check len=${cr.text.length} 命中登录成功=${cr.text.includes("登录成功")}`);
  if (cr.text.includes("二次认证")) throw new Error("nextthuxk: id 要求二次认证（2FA）");
  if (!cr.text.includes("登录成功")) {
    throw new Error(`nextthuxk: CAS 未成功 ${cr.text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  // ④ 锚点落地
  const anchor = /<a[^>]+href="([^"]+)"/i.exec(cr.text)?.[1];
  if (!anchor) throw new Error("nextthuxk: 登录成功页无锚点");
  const land = await nt.follow(new URL(anchor, ID_CHECK + "/").href);
  nt.log?.(`[NT] 落地=${land.finalUrl.slice(0, 90)}`);
  // ⑤ 包装 base 自适应（落地 webvpn 则提取；直连则空）
  const wv = land.finalUrl.match(/^(https:\/\/webvpn\.tsinghua\.edu\.cn\/\w+\/[^/]+\/)/);
  const base = wv?.[1] ?? ZHJWXK + "/";
  return { jar: nt.jar, base, finalLandingUrl: land.finalUrl };
}

/**
 * isoFetchFactory 同形接口的平铺罐引擎（替代 zhjwxkTransport）：
 * - 直连一切（xklogin/id/zhjwxk，NextTHUxk 同款——zhjwxk 公网可达由生产验证）
 * - 平铺罐 name→value 全发（服务器各取所需，多发无害）
 * - POST→302 转 GET、GBK 解码、x-onethu 头保持与 http.ts 的既有联动
 * - 种子：调用方传入的罐（iso 拷贝）里的 webvpn+id cookie 平铺合并
 */
export function makeNtFetchFactory(
  /** WebView 内传 tauriFetch（无 CORS、支持 manual 跳转+set-cookie） */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): (
  jar: { getCookies(u: URL): Array<{ name: string; value: string }> },
) => (input: URL | RequestInfo | string, init?: RequestInit) => Promise<Response> {
  return (jar: { getCookies(u: URL): Array<{ name: string; value: string }> }) => {
    const nt = new Nt();
    if (fetchImpl) nt.fetchImpl = fetchImpl;
    let seeded = false;
    const seed = (j: { getCookies(u: URL): Array<{ name: string; value: string }> }) => {
      if (seeded) return;
      seeded = true;
      for (const b of ["https://webvpn.tsinghua.edu.cn/", "https://oauth.tsinghua.edu.cn/", "https://id.tsinghua.edu.cn/"]) {
        for (const c of j.getCookies(new URL(b))) nt.jar[c.name] = c.value;
      }
    };
    return async (input: URL | RequestInfo | string, init?: RequestInit): Promise<Response> => {
      seed(jar);
      const hopRecords: Array<{ u: string; l: string }> = [];
      // 上游可能传来包装 URL（iso client 带 webVPNEncoder）：解回直连（nt 语义=直连一切）
      const rawUrl = typeof input === "string" ? input : input.toString();
      let cur = decodeUrl(rawUrl) ?? rawUrl;
      let method = (init?.method ?? "GET").toUpperCase();
      let body = init?.body;
      let finalRes: Response | null = null;
      let finalUrl = cur;
      for (let i = 0; i < 15; i++) {
        const headers: Record<string, string> = { "User-Agent": UA, Cookie: nt.cookieHeader() };
        if (body !== undefined && method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
        const res = await nt.fetchImpl(cur, { method, redirect: "manual", headers, body });
        nt.save(res);
        for (const sc of (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) {
          hopRecords.push({ u: cur, l: sc });
        }
        finalUrl = cur;
        if ([301, 302, 307, 308].includes(res.status)) {
          const loc = res.headers.get("location") ?? "";
          if (!loc) { finalRes = res; break; }
          cur = loc.startsWith("http") ? loc : new URL(loc, cur).href;
          if (method === "POST") { method = "GET"; body = undefined; }
          continue;
        }
        finalRes = res;
        break;
      }
      if (!finalRes) throw new Error("nextthuxk: 跟跳耗尽");
      const buf = await finalRes.arrayBuffer();
      const headers = new Headers();
      headers.set("Content-Type", finalRes.headers.get("content-type") ?? "text/html; charset=utf-8");
      headers.set("x-onethu-final-url", finalUrl);
      if (hopRecords.length) headers.set("x-onethu-set-cookie-hops", JSON.stringify(hopRecords));
      return new Response(buf, { status: finalRes.status, headers });
    };
  };
}
