/**
 * 浏览器驱动的登录（2026-09-20 重构，learnX/thu-learn-lib 路线）：
 *
 * HTTP 字符串模型在 learn 二轮 doubleAuth 上反复受挫（单字符串 JSESSIONID
 * 同名碰撞、redirect2Jsp 的 JS 自动续跳、id/门户/learn 三域会话互相踩），
 * 逐跳日志实锤修不胜修。真实 Chromium 里这一切原生成立。
 *
 * 入口走**直连**（learnX 同款）：直接打开 learn.tsinghua.edu.cn → 直连 id CAS
 * 表单（预填账密）→ 动态码用户在窗口内完成 → redirect2Jsp 的 JS 续跳由浏览器
 * 自己跑 → 落在直连课程页。门户（webvpn）入口作废——门户的 CAS 是代理在
 * 自己域名下的，浏览器全程不触 id 域，id cookie 对永远种不上（2026-09-20
 * 21:37 登录实录 idCookies=empty）。
 *
 * 导出：learn 直连会话（数据面直连直接用）+ id 域完整 cookie 对（重漫游凭据）
 * + 门户会话（供校园卡等内网应用的包装兑付，能拿到就带）。
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";

const LEARN_COURSE_LIST = "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/";

export interface BrowserLoginResult {
  /** 网络学堂课程页取到的 _csrf（与 HTTP 链同款判定） */
  csrf: string;
  /** learn.tsinghua.edu.cn 域 cookie 串——**直连**会话，learn 数据面直接用 */
  learnCookies: string;
  /** id.tsinghua.edu.cn 域完整 cookie 串（JSESSIONID+TSINGHUAUSERID；
   *  learn 直连重漫游的认证 cookie 对，learnX/thu-learn-lib 路线的凭据） */
  idCookies: string;
  /** webvpn 门户会话（校园卡等内网应用包装兑付用；直连流程可能为空） */
  portalCookies: string;
}

/** 启动真实浏览器（Edge → Chrome 逐个试，都有头）。 */
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

const jarString = (all: { name: string; value: string }[]) =>
  all.map((c) => `${c.name}=${c.value}`).join("; ");

export async function browserLogin(opts: {
  username: string;
  password: string;
  /** 持久 profile 目录（跨次登录保留会话，二次登录可能全程免操作） */
  profileDir: string;
  onStage: (msg: string) => void;
  timeoutMs?: number;
}): Promise<BrowserLoginResult> {
  const { username, password, profileDir, onStage } = opts;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  onStage("正在打开浏览器登录窗口（Edge，直连网络学堂）…");
  const ctx = await launchBrowser(profileDir);
  let closed = false;
  ctx.on("close", () => { closed = true; });

  const page: Page = ctx.pages()[0] ?? await ctx.newPage();
  // 直连入口：learn 课程页会把未登录的浏览器 302 到直连 id CAS 表单
  try {
    await page.goto(LEARN_COURSE_LIST, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch {
    onStage("网络学堂打开缓慢，继续等待…");
  }

  // 预填账密（best-effort：凭据齐且有 CAS 登录表单才自动填；动态码留给用户在窗口内完成。
  // 没有记住的凭据时跳过——用户直接在窗口里输入）
  if (username && password) {
    try {
      await page.waitForSelector("#i_user", { timeout: 10_000 });
      await page.fill("#i_user", username);
      await page.fill("#i_pass", password);
      onStage("已自动填入账号密码，如页面有动态码/验证请直接在窗口内完成");
      await page.press("#i_pass", "Enter");
    } catch {
      onStage("登录窗口已打开（可能已登录或页面结构变化），请在窗口内完成登录");
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
      // 按 URL 语义导出：ctx.cookies(url) 返回「浏览器访问该 URL 会携带的全部 cookie」
      const learnCookies = jarString(await ctx.cookies("https://learn.tsinghua.edu.cn/"));
      const idCookies = jarString(await ctx.cookies("https://id.tsinghua.edu.cn/"));
      const portalCookies = jarString(await ctx.cookies("https://webvpn.tsinghua.edu.cn/"));
      const result: BrowserLoginResult = { csrf, learnCookies, idCookies, portalCookies };
      onStage("网络学堂会话已建立，正在导出会话并关闭浏览器…");
      await ctx.close().catch(() => undefined);
      return result;
    }

    // 兜底驱动：长时间停在 learn 首页/门户（无表单、无验证页）时重打课程页
    const noAuthForm = !/i_user|doubleauth|动态码|vericode|二次验/i.test(html);
    if (noAuthForm && html && /tsinghua\.edu\.cn/.test(url) &&
        Date.now() - lastDrive > 15_000 && !/wlxt/i.test(url)) {
      lastDrive = Date.now();
      onStage("重新打开网络学堂课程页…");
      await page.goto(LEARN_COURSE_LIST, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(1_500).catch(() => undefined);
  }
  await ctx.close().catch(() => undefined);
  throw new Error("浏览器登录超时（" + Math.round(timeoutMs / 60_000) + " 分钟）——请在窗口内完成全部验证步骤");
}
