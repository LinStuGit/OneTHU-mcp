/**
 * 本地复现：蜂窝（webvpn 模式）选课建链 —— 真实凭据 + 真实服务器 + 同栈同语义。
 * ⚠️ 探针会真实登录（与手机 webvpn 会话互踢，跑探针时别用手机 app）。
 * 用法：pnpm exec tsx scripts/xk-webvpn-probe.mts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HttpClient,
  MemoryCookieJar,
  DEFAULT_USER_AGENT,
  PUBLIC_DIRECT_HOSTS,
  webvpnWrap,
  webvpnDecodeUrl,
} from "../packages/core/src/index.js";
import { demoLogin, newDemoSession } from "../packages/core/src/auth/demoLogin.js";
import { getSelectedCourses, setZhjwxkDebug } from "../packages/core/src/zhjwxk/client.js";

const STATE = join(homedir(), "Library/Application Support/app.onethu.desktop/state");
const SECRET_MAGIC = "onethu-secret-v1:";

function deobfuscate(stored: string, username: string): string {
  if (!stored.startsWith(SECRET_MAGIC)) return "";
  const bin = atob(stored.slice(SECRET_MAGIC.length));
  const key = new TextEncoder().encode(`OneTHU|${username}|remember`);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key[i % key.length]!;
  return new TextDecoder().decode(bytes);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const hopFetch: FetchLike = async (url, init = {}) => {
  // demoLogin（webvpnRequest）传 redirect:"manual" 期望单跳响应自管跟跳——
  // 必须尊重：整链自跟会架空其逐跳 cookie 攒集（探针曾据此得出假结论）
  if (init.redirect === "manual") {
    const res = await fetch(url, { ...init, redirect: "manual" } as RequestInit);
    const headers = new Headers(res.headers);
    return new Response(await res.text(), { status: res.status, headers });
  }
  let currentUrl = url;
  let method = init.method ?? "GET";
  let body = init.body as string | undefined;
  const initHeaders = (init.headers ?? {}) as Record<string, string>;
  let chainEverVpn = false;
  const hopRecords: Array<{ u: string; l: string }> = [];
  const chainCookies = new Map<string, string>();

  for (let hop = 0; hop < 12; hop++) {
    // headers 兼容三形态（Headers 实例/数组/普通对象）——此前把 Headers 实例当
    // 普通对象展开=全部丢弃（Cookie 裸奔 → gb2312 假阳性）
    const hdrs = new Headers();
    hdrs.set("User-Agent", DEFAULT_USER_AGENT);
    const ih: unknown = init.headers;
    if (ih instanceof Headers) ih.forEach((v, k) => hdrs.set(k, v));
    else if (Array.isArray(ih)) for (const [k, v] of ih) hdrs.set(k, String(v));
    else if (ih && typeof ih === "object") for (const [k, v] of Object.entries(ih as Record<string, string>)) hdrs.set(k, v);
    // 三层 cookie（transport.ts 同款）：seed < 本跳真实域(provider) < 链内新发(chain)
    const seedMap = new Map<string, string>();
    const seedHdr = hdrs.get("Cookie") ?? hdrs.get("cookie") ?? "";
    for (const pair of seedHdr.split("; ")) {
      const i = pair.indexOf("=");
      if (i > 0) seedMap.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const origin = webvpnDecodeUrl(currentUrl) ?? currentUrl;
    let extra: string | null = null;
    try {
      const cs = jar.getCookies(new URL(origin));
      if (cs.length) extra = cs.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch { /* ignore */ }
    const pairs = new Map(seedMap);
    if (extra) for (const pair of extra.split("; ")) {
      const i = pair.indexOf("=");
      if (i > 0 && !pairs.has(pair.slice(0, i))) pairs.set(pair.slice(0, i), pair.slice(i + 1));
    }
    for (const [k, v] of chainCookies) pairs.set(k, v);
    if (pairs.size > 0) hdrs.set("Cookie", [...pairs].map(([k, v]) => `${k}=${v}`).join("; "));
    else hdrs.delete("Cookie");
    const cookieHdr = hdrs.get("Cookie") ?? undefined;
    if (cookieHdr) {
      const jsid = /JSESSIONID=([^;\s]+)/.exec(cookieHdr)?.[1] ?? "无";
      console.log(`    »» 发送 ${method} ${currentUrl.slice(0, 95)}\n       JSESSIONID=${jsid.slice(0, 20)}… cookies=${cookieHdr.replace(/=[^;]{6,}/g, "=").slice(0, 130)}`);
    }
    const res = await fetch(currentUrl, {
      method,
      body,
      headers: hdrs,
      redirect: "manual",
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      hopRecords.push({ u: currentUrl, l: sc });
      const m = /^([^=]+)=([^;]*)/.exec(sc);
      if (m?.[1]) chainCookies.set(m[1].trim(), m[2] ?? "");
      console.log(`    hop ${res.status} ${currentUrl.slice(0, 90)}  +cookie:${/^([^=;]+)/.exec(sc)?.[1]}`);
    }
    if (!(res.status >= 300 && res.status < 400)) {
      const headers = new Headers(res.headers);
      if (hopRecords.length) headers.set("x-onethu-set-cookie-hops", JSON.stringify(hopRecords));
      headers.set("x-onethu-final-url", currentUrl);
      return new Response(await res.text(), { status: res.status, headers });
    }
    const loc = res.headers.get("location");
    if (!loc) {
      const headers = new Headers(res.headers);
      if (hopRecords.length) headers.set("x-onethu-set-cookie-hops", JSON.stringify(hopRecords));
      headers.set("x-onethu-final-url", currentUrl);
      return new Response(await res.text(), { status: res.status, headers });
    }
    let next = new URL(loc, currentUrl).toString();
    if (next.startsWith("https://webvpn.tsinghua.edu.cn/")) chainEverVpn = true;
    if (chainEverVpn && !next.startsWith("https://webvpn.tsinghua.edu.cn/")) {
      try {
        const h = new URL(next).hostname;
        if (!PUBLIC_DIRECT_HOSTS.has(h)) next = webvpnWrap(next);
      } catch { /* 保持 */ }
    }
    console.log(`    → ${res.status} ${next.slice(0, 100)}`);
    currentUrl = next;
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("重定向超限（probe）");
};

const credRaw = readFileSync(join(STATE, "credentials.json"), "utf8");
const cred = JSON.parse(credRaw) as { username: string; secret: string };
const password = deobfuscate(cred.secret, cred.username);
if (!password) throw new Error("凭据解不出");
const sessRaw = JSON.parse(readFileSync(join(STATE, "session.json"), "utf8")) as { fingerprint?: string; finger3?: string };
const fingerprint = sessRaw.fingerprint ?? "";
const finger3 = sessRaw.finger3 ?? "";
console.log(`[probe] 账号=${cred.username} fp=${fingerprint.slice(0, 12)}…`);

const jar = new MemoryCookieJar();
const http = new HttpClient({ fetch: hopFetch, jar });
http.withWebVPN(true);
http.webVPNEncoder = (u) => webvpnWrap(u);

setZhjwxkDebug((line) => console.log(`[XK] ${line}`));

console.log("\n[probe] ① demoLogin 建立会话…");
const demo = newDemoSession();
const loginResult = await demoLogin(hopFetch, cred.username, password, demo, fingerprint, finger3);
if (typeof loginResult === "object") throw new Error(`登录失败: ${loginResult.error}`);
console.log(`[probe] 登录链 ok`);

for (const [d, src] of [
  ["https://webvpn.tsinghua.edu.cn/", demo.webvpnCookies],
  ["https://id.tsinghua.edu.cn/", demo.webvpnCookies],
  ["https://oauth.tsinghua.edu.cn/", demo.webvpnCookies],
] as Array<[string, string]>) {
  if (!src) continue;
  for (const pair of src.split("; ")) {
    if (/^[A-Za-z0-9_]+=.+/.test(pair)) jar.setRaw(new URL(d), `${pair}; Path=/`);
  }
}
console.log("[probe] jar 已灌");
console.log(`[probe] demo.webvpnCookies=${demo.webvpnCookies?.slice(0, 200) ?? "undefined"}`);
const dump = jar.getCookies(new URL("https://webvpn.tsinghua.edu.cn/"));
console.log(`[probe] webvpn桶=${dump.map((c) => c.name).join(",") || "空"}`);
const dumpId = jar.getCookies(new URL("https://id.tsinghua.edu.cn/"));
console.log(`[probe] id桶=${dumpId.map((c) => c.name).join(",") || "空"}`);

console.log("\n[probe] ② zhjwxk 建链…");
const t0 = Date.now();
try {
  const courses = await getSelectedCourses({ http, username: cred.username, password, fingerprint } as Parameters<typeof getSelectedCourses>[0]);
  console.log(`\n[probe] ✅ 选课链通了！已选 ${courses.length} 门 (${Date.now() - t0}ms)`);
} catch (err) {
  console.log(`\n[probe] ❌ 选课链死：${String(err)} (${Date.now() - t0}ms)`);
  console.log(`[probe] lastDebug=${http.lastDebug?.slice(0, 600)}`);
  console.log(`[probe] lastFinalUrl=${http.lastFinalUrl}`);
  console.log(`[probe] lastCookieNames=${http.lastCookieNames}`);
  process.exitCode = 1;
}
