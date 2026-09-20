/**
 * 浏览器驱动的登录（2026-09-20 重构，参照 OneTHU 宿主/OneTHU-Harness 的
 * 「会话建立在真实引擎里完成」原理）：
 *
 * HTTP 字符串模型在 learn 二轮 doubleAuth 上反复受挫（单字符串 JSESSIONID
 * 同名碰撞、redirect2Jsp 的 JS 自动续跳、id/门户/learn 三域会话互相踩），
 * 逐跳日志实锤修不胜修。真实 Chromium 里这一切原生成立：CAS 表单、doubleAuth
 * SPA、redirect2Jsp 的 script 续跳、wengine 服务端 learn 会话，浏览器全包。
 *
 * 流程：打开 Edge（有头，持久 profile）→ 门户外自动预填账密（best-effort，
 * 动态码由用户在窗口内完成）→ 轮询直至「网络学堂课程页出现 _csrf」→
 * 导出 webvpn 门户 cookie 串 + id JSESSIONID 交回 HTTP 数据面。
 * wengine 模型：门户会话即一切（逐跳日志实锤：单个门户 JSESSIONID 支配
 * 全部包装请求），learn 的会话由 wengine 服务端持有，浏览器只需门户 cookie。
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { webvpnWrap } from "../packages/core/src/crypto/webvpn.js";

const PORTAL_LOGIN = "https://webvpn.tsinghua.edu.cn/login";
const LEARN_COURSE_LIST = "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/";

export interface BrowserLoginResult {
  /** 网络学堂课程页取到的 _csrf（与 HTTP 链同款判定） */
  csrf: string;
  /** webvpn.tsinghua.edu.cn 域 cookie 串（demo 字符串模型的门户会话） */
  portalCookies: string;
  /** id.tsinghua.edu.cn 域完整 cookie 串（JSESSIONID+TSINGHUAUSERID；
   *  learn 直连重漫游的认证 cookie 对，learnX/thu-learn-lib 路线的凭据） */
  idCookies: string;
}

/** 启动真实浏览器（Edge → Chrome 逐个试，都有头）。返回已打开门户登录页的上下文。 */
async function launchBrowser(profileDir: string): Promise<BrowserContext> {
  const errors: string[] = [];
  for (const channel of ["msedge", "chrome"] as const) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        channel,
        headless: false,
        viewport: null,
        args: ["--start-maximized"],
      });
    } catch (e) {
      errors.push(channel + ": " + String(e instanceof Error ? e.message.split("\n")[0] : e).slice(0, 120));
    }
  }
  throw new Error("无法启动浏览器（" + errors.join("；") + "）");
}

export async function browserLogin(opts: {
  username: string;
  password: string;
  /** 持久 profile 目录（跨次登录保留门户会话，二次登录可能全程免操作） */
  profileDir: string;
  onStage: (msg: string) => void;
  timeoutMs?: number;
}): Promise<BrowserLoginResult> {
  const { username, password, profileDir, onStage } = opts;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const wrappedCourse = webvpnWrap(LEARN_COURSE_LIST);

  onStage("正在打开浏览器登录窗口（Edge）…");
  const ctx = await launchBrowser(profileDir);
  let closed = false;
  ctx.on("close", () => { closed = true; });

  const page: Page = ctx.pages()[0] ?? await ctx.newPage();
  try {
    await page.goto(PORTAL_LOGIN, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch {
    onStage("门户页打开缓慢，继续等待…");
  }

  // 预填账密（best-effort：凭据齐且有登录表单才自动填；动态码留给用户在窗口内完成。
  // 没有记住的凭据时跳过——用户直接在窗口里输入）
  if (username && password) {
    try {
      await page.waitForSelector("#i_user", { timeout: 8_000 });
      await page.fill("#i_user", username);
      await page.fill("#i_pass", password);
      onStage("已自动填入账号密码，如页面有动态码/验证请直接在窗口内完成");
      await page.press("#i_pass", "Enter");
    } catch {
      onStage("登录窗口已打开，请在窗口内完成登录");
    }
  } else {
    onStage("登录窗口已打开，请在窗口内输入账号密码并完成验证");
  }

  const deadline = Date.now() + timeoutMs;
  let lastDrive = 0;
  while (Date.now() < deadline) {
    if (closed) throw new Error("用户关闭了浏览器窗口，登录中止");
    let html = "";
    let url = "";
    try {
      html = await page.content();
      url = page.url();
    } catch { /* 页面跳转中，下一轮再取 */ }

    // 成功判定与 HTTP 链同款：课程页出现 _csrf（CAS/登录页绝无此字段）
    const csrf = /_csrf=([^&"'\s<]+)/.exec(html)?.[1] ?? "";
    if (csrf && !/i_user|sm2publicKey/.test(html)) {
      // 按 URL 语义导出：ctx.cookies(url) 返回「浏览器访问该 URL 会携带的全部
      // cookie」——父域（.tsinghua.edu.cn）的 wengine_vpn_ticket 也在内。早先按
      // 域名子串过滤把 ticket 漏了，门户只剩 JSESSIONID 一只手 handshake（实录：
      // 复放被弹 /login）。id 域同理取主会话 JSESSIONID。
      const portalCookies = (await ctx.cookies("https://webvpn.tsinghua.edu.cn/"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const idCookies = (await ctx.cookies("https://id.tsinghua.edu.cn/"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const result: BrowserLoginResult = {
        csrf,
        portalCookies,
        idCookies,
      };
      onStage("网络学堂会话已建立，正在导出会话并关闭浏览器…");
      await ctx.close().catch(() => undefined);
      return result;
    }

    // 驱动：门户会话建立后（页面无登录表单、无验证页），打开网络学堂课程页。
    // 若 learn 弹二轮验证，用户在窗口内完成，redirect2Jsp 的 JS 续跳由浏览器
    // 自己跑完——轮询自然看到课程页。
    const noAuthForm = !/i_user|doubleauth|动态码|vericode|二次验/i.test(html);
    const onWebvpn = /webvpn\.tsinghua\.edu\.cn/.test(url);
    if (onWebvpn && noAuthForm && html && Date.now() - lastDrive > 12_000 && !/wlxt/i.test(url)) {
      lastDrive = Date.now();
      onStage("门户会话已建立，打开网络学堂…");
      await page.goto(wrappedCourse, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(1_500).catch(() => undefined);
  }
  await ctx.close().catch(() => undefined);
  throw new Error("浏览器登录超时（" + Math.round(timeoutMs / 60_000) + " 分钟）——请在窗口内完成全部验证步骤");
}
