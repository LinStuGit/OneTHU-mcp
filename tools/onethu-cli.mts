/**
 * OneTHU CLI sidecar —— @onethu/core 全能力命令行封装（Kami 桥接用）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs tools/onethu-cli.mts <cmd> [jsonArgs]
 *   - 结果以一行 JSON 信封输出到 stdout：{"ok":true,"data":...}
 *   - login 走 stdin 交互（密码不进 argv）：stdin 先收 {"username","password","remember"}，
 *     需要二次认证时输出 {"ev":"need-2fa",...}，再从 stdin 逐行读 {"op":...} 指令
 *   - 状态目录：环境变量 ONETHU_STATE_DIR（默认 ~/.onethu-cli），存会话 cookie 与
 *     可选「记住密码」（自动重登用；明文 JSON，目录须仅本人可读）
 *
 * 依赖（repo 根 node_modules，npm i --no-save --ignore-scripts）：tsx / aes-js / sm-crypto
 */
import * as core from "../packages/core/src/index.js";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

/* ── 状态目录 ─────────────────────────────────────────────── */

const STATE_DIR = process.env.ONETHU_STATE_DIR ?? join(homedir(), ".onethu-cli");
const SESSION_FILE = join(STATE_DIR, "session.json");
const SECRET_FILE = join(STATE_DIR, "secret.json");

interface Secret { username: string; password: string }

function loadJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function loadSessionData(): core.SessionData | null {
  return loadJson(SESSION_FILE);
}

/* ── secret.json 只存 DPAPI(CurrentUser) 加密块，绝不明文落盘。
 *    管道两端都是 base64（ASCII），避开 PowerShell 控制台编码坑。 ── */

function execOut(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d.toString()));
    c.stderr.on("data", () => { /* 静默 */ });
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(cmd + " exit " + code)));
    c.stdin.end(input, "utf8");
  });
}

async function dpapi(mode: "protect" | "unprotect", b64: string): Promise<string> {
  const scope = "[Security.Cryptography.DataProtectionScope]::CurrentUser";
  const script = mode === "protect"
    ? "$t=[Console]::In.ReadToEnd();"
      + "Add-Type -AssemblyName System.Security;"
      + "$b=[Convert]::FromBase64String($t.Trim());"
      + "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null," + scope + "))"
    : "$t=[Console]::In.ReadToEnd();"
      + "Add-Type -AssemblyName System.Security;"
      + "$b=[Convert]::FromBase64String($t.Trim());"
      + "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null," + scope + ");"
      + "[Convert]::ToBase64String($p)";
  const out = await execOut("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script], b64);
  return mode === "protect" ? out
    : Buffer.from(out, "base64").toString("utf8");
}

async function loadSecret(): Promise<Secret | null> {
  const raw = loadJson(SECRET_FILE);
  if (!raw) return null;
  try {
    if (typeof raw.protected === "string" && raw.protected) {
      const s = JSON.parse(await dpapi("unprotect", raw.protected));
      if (s && s.username && s.password) return s;
    } else if (raw.username && raw.password) {
      return raw; // 遗留明文文件：兼容读（新写入一律加密）
    }
  } catch { /* 损坏/换用户：当无 secret */ }
  return null;
}

function saveSessionData(s: core.SessionData): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 1), "utf-8");
}

async function saveSecret(s: Secret): Promise<void> {
  if (process.platform !== "win32") {
    fail("记住密码目前仅支持 Windows（DPAPI 加密）；不加密就不保存");
  }
  const plain = Buffer.from(JSON.stringify(s), "utf8").toString("base64");
  const blob = await dpapi("protect", plain);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SECRET_FILE,
    JSON.stringify({ username: s.username, protected: blob }, null, 1),
    "utf-8");
}

function clearState(): void {
  for (const f of [SESSION_FILE, SECRET_FILE]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
}

/* ── Node fetchLike：手动走重定向，逐跳喂 cookie，回传 x-onethu-final-url ── */

function makeFetchLike(getJar: () => core.CookieJar | null): core.FetchLike {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    let cur = String(url);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body as any;
    const headers = init.headers;
    for (let hop = 0; hop < 25; hop++) {
      const resp = await fetch(cur, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: AbortSignal.timeout(50_000),
      });
      const jar = getJar();
      if (jar) {
        try { jar.setFromResponse(new URL(cur), resp); } catch { /* ignore */ }
      }
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (loc) {
          cur = new URL(loc, cur).toString();
          if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
            method = "GET";
            body = undefined;
          }
          try { await resp.arrayBuffer(); } catch { /* 耗尽响应体防悬挂 */ }
          continue;
        }
      }
      // 终点：重包一层，带最终落点头（core 靠它判「被踢到登录页」），保留 set-cookie
      const out = new Headers();
      for (const [k, v] of resp.headers.entries()) {
        if (k !== "set-cookie") out.append(k, v);
      }
      for (const c of resp.headers.getSetCookie()) out.append("set-cookie", c);
      out.set("x-onethu-final-url", cur);
      const buf = await resp.arrayBuffer();
      return new Response(buf, {
        status: resp.status,
        statusText: resp.statusText,
        headers: out,
      });
    }
    throw new Error("重定向超过 25 跳");
  };
}

/* ── 会话装配（对齐 apps/desktop/src/lib/clients.ts 的标准接线） ── */

interface Boot {
  http: core.HttpClient;
  session: core.CampusSession;
  info: core.InfoClient;
  learn: core.LearnClient;
  state: { session: core.SessionData | null; secret: Secret | null };
}

function boot(secret: Secret | null): Boot {
  const state = { session: loadSessionData(), secret };
  const holder: { http: core.HttpClient | null } = { http: null };
  const fetchLike = makeFetchLike(() => holder.http?.jar ?? null);
  const http = new core.HttpClient({ fetch: fetchLike });
  holder.http = http;
  http.webVPNEncoder = core.webvpnWrap;
  const learn = new core.LearnClient(http);
  const info = new core.InfoClient(http);
  const session = new core.CampusSession({
    http, learn, info, fetchLike,
    fingerprint: state.session?.fingerprint,
  });
  http.onAuthRequired(async () => {
    if (state.secret) {
      try { await session.softRelogin(); } catch { /* 交给业务层报错 */ }
    }
  });
  if (state.session) {
    try {
      http.jar.hydrate(state.session.cookiesJson);
      session.username = state.session.username;
      if (state.session.fingerprint) session.fingerprint = state.session.fingerprint;
      session.finger3 = state.session.finger3 ?? "";
      session.restoreDemo(state.session.demoCookies ?? "", state.session.idJsid ?? "");
      session.restoreInfoCookies(state.session.infoCookies ?? "");
      if (state.secret) session.injectCredentials(state.secret.username, state.secret.password);
      // cookiesJson 在快照里时分域 cookie 是忠实的，reseed() 会用单 JSESSIONID 的
      // 字符串模型覆盖 learn 桶（core 警告同款坑）→ 跨进程必死。仅遗留快照才 reseed。
      if (!state.session.cookiesJson) session.reseed();
    } catch { /* 坏快照当无会话处理 */ }
  }
  return { http, session, info, learn, state };
}

/** 恢复快照后的活体检修（桌面 resumeSession 同款）：SSO 免密重漫游重建 learn；
 *  仍死且有记住密码 → 完整重登并落盘。绝不抛——修不好就让业务调用自己报实情。 */
async function revive(b: Boot): Promise<void> {
  if (!b.state.session) return;
  const alive = async (): Promise<boolean> => {
    try { await b.learn.getCurrentSemester(); return true; }
    catch { return false; }
  };
  try {
    if (await alive()) return;
    // 新进程 #csrf 不在快照里（必空）：先 resume 抓课程页 csrf；但登录页也含
    // _csrf 字样会误报 → 用 getCurrentSemester 的真 JSON 返回验证。
    let ok = false;
    try { ok = await b.learn.resume(); } catch { ok = false; }
    if (ok) ok = await alive();
    if (!ok) { try { ok = await b.session.relearnRoam(); } catch { ok = false; } }
    if (ok) ok = await alive();
    if (!ok && b.state.secret) {
      await b.session.relogin(b.state.secret.username, b.state.secret.password);
      ok = await alive();
    }
    if (ok) {
      persist(b);
      process.stderr.write("[revive] session rebuilt\n");
      return;
    }
    process.stderr.write("[revive] dead. http.lastDebug=" + b.http.lastDebug.slice(0, 700) + "\n");
  } catch (e) {
    // 修不活不拦路：业务调用会报真实错误；这里留痕到 stderr 便于诊断
    process.stderr.write("[revive] " + (e instanceof Error ? e.message : String(e)) + "\n");
  }
}




function persist(b: Boot): void {
  const s: core.SessionData = {
    username: b.session.username,
    fingerprint: b.session.fingerprint,
    cookiesJson: b.http.jar.serialize(),
    demoCookies: b.session.demoSnapshot,
    idJsid: b.session.idJsidSnapshot,
    infoCookies: b.session.infoEraSnapshot,
    finger3: b.session.finger3,
    savedAt: Date.now(),
  };
  saveSessionData(s);
  b.state.session = s;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(msg: string, detail?: unknown): never {
  const out: any = { ok: false, error: msg };
  if (detail !== undefined) {
    out.detail = detail instanceof Error ? (detail as any).detail ?? String(detail) : detail;
  }
  emit(out);
  process.exit(1);
}

function needLogin(b: Boot): void {
  if (!b.state.session) {
    fail("尚未登录：先执行一次 onethu login（或让桥接侧代跑）");
  }
}

/** 只读命令的自动自愈：会话失效 → 用记住的密码重登一次 → 重试原操作。
 *  写操作（book/submit/drop/cancel）绝不自动重试，防重复提交。 */
async function withAuth<T>(b: Boot, fn: () => Promise<T>, safe = true): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const authy = err instanceof core.AuthRequiredError
      || (core as any).isAuthError?.(err) === true
      || /重新登录|登录已过期|会话未能建立|looksLoggedOut|未登录|无权限|漫游|roamingurl|登录超时/i.test(msg);
    if (!safe || !authy || !b.state.secret) throw err;
    await b.session.relogin(b.state.secret.username, b.state.secret.password);
    persist(b);
    return await fn();
  }
}

function xkSession(b: Boot): core.ZhjwxkSession {
  if (!b.state.secret) {
    fail("选课功能需要「记住密码」（login 时 remember=true），以便独立通道直登选课系统");
  }
  return {
    http: b.http,
    username: b.state.secret.username,
    password: b.state.secret.password,
    fingerprint: b.session.fingerprint,
  } as core.ZhjwxkSession;
}

const day = (offset = 0): string => {
  const d = new Date(Date.now() + offset * 86400_000);
  return d.toISOString().slice(0, 10);
};

type Cmd = (b: Boot, args: any) => Promise<unknown>;
const commands: Record<string, Cmd> = {};
function reg(name: string, fn: Cmd): void { commands[name] = fn; }

/* ── 会话 / 登录 ── */

reg("status", async (b) => ({
  loggedIn: !!b.state.session,
  username: b.session.username || b.state.session?.username || "",
  savedAt: b.state.session?.savedAt ?? null,
  hasSecret: !!b.state.secret,
  sessionState: b.session.state,
}));

reg("logout", async (b) => {
  try { b.session.reset(); } catch { /* ignore */ }
  clearState();
  return { cleared: true };
});

reg("keepalive", async (b) => {
  needLogin(b);
  return { verdict: await withAuth(b, () => b.session.keepalive(), false) };
});

reg("login", async (b, args) => {
  const username = String(args.username ?? "").trim();
  const password = String(args.password ?? "");
  if (!username || !password) fail("需要 username / password");
  b.session.fingerprint = b.state.session?.fingerprint ?? b.session.fingerprint;
  b.session.finger3 = b.state.session?.finger3 ?? "";
  const result: any = await b.session.login(username, password);
  if (result?.state === "need-2fa" || result?.state === "need-learn-2fa") {
    // login() 直落 learn 二轮墙时同样进交互循环（事件名即阶段名，桥/webui 已认）
    emit({ ev: result.state, methods: result.methods ?? [] });
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let op: any;
      try { op = JSON.parse(t); } catch { continue; }
      if (op.op === "cancel") fail("已取消登录");
      try {
        if (op.op === "send") {
          await b.session.send2FA(String(op.type));
          emit({ ev: "2fa-sent", type: String(op.type) });
        } else if (op.op === "verify") {
          const round2: any = await b.session.verify2FA(String(op.code), op.trust !== false);
          if (round2 && Array.isArray(round2) && round2.length) {
            emit({ ev: "need-learn-2fa", methods: round2 });
          } else {
            break;
          }
        } else if (op.op === "learn-send") {
          await b.session.sendLearn2FA(String(op.type));
          emit({ ev: "learn-2fa-sent", type: String(op.type) });
        } else if (op.op === "learn-verify") {
          await b.session.verifyLearn2FA(String(op.code));
          break;
        }
      } catch (err) {
        emit({ ev: "op-error", error: err instanceof Error ? err.message : String(err) });
      }
    }
    rl.close();
  }
  persist(b);
  if (args.remember !== false) await saveSecret({ username, password });
  return { username: b.session.username, sessionState: b.session.state };
});

/* ── 信息门户（读） ── */

reg("whoami", async (b) => { needLogin(b); return withAuth(b, () => b.info.getUserInfo()); });

reg("schedule", async (b, a) => {
  needLogin(b);
  const start = String(a?.start ?? day(0));
  const end = String(a?.end ?? day(13));
  return withAuth(b, () => b.info.getSchedule(start, end));
});

reg("report", async (b) => { needLogin(b); return withAuth(b, () => b.info.getReport()); });
reg("deadlines", async (b) => { needLogin(b); return withAuth(b, () => b.info.getDeadlines()); });
reg("exams", async (b) => { needLogin(b); return withAuth(b, () => b.info.getExams()); });

reg("news", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getNews(Number(a?.page ?? 1), Number(a?.length ?? 15)));
});

reg("news-detail", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getNewsDetail(String(a.id)));
});

reg("news-search", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.searchNews(String(a.keyword ?? ""), Number(a?.page ?? 1)));
});

reg("calendar", async (b) => { needLogin(b); return withAuth(b, () => b.info.getSchoolCalendar()); });

reg("classrooms", async (b, a) => {
  needLogin(b);
  if (a?.building) {
    return withAuth(b, () => b.info.getClassroomState(String(a.building), Number(a.week ?? 1)));
  }
  return withAuth(b, () => b.info.getClassroomList());
});

reg("fitness", async (b) => { needLogin(b); return withAuth(b, () => b.info.getPhysicalExamResult()); });
reg("dorm-score", async (b) => { needLogin(b); return withAuth(b, () => b.info.getDormScore()); });

reg("invoices", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getInvoiceList(Number(a?.page ?? 1)));
});

reg("bank", async (b) => { needLogin(b); return withAuth(b, () => b.info.getBankPayment()); });

reg("income", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getGraduateIncome(String(a?.begin ?? day(-90)), String(a?.end ?? day(0))));
});

/* ── 校园卡 / 电费 / 校园网（读） ── */

reg("card-info", async (b) => { needLogin(b); return withAuth(b, () => b.info.getCardInfo()); });

reg("card-tx", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getCardTransactions(
    String(a?.start ?? day(-30)), String(a?.end ?? day(0))));
});

reg("ele", async (b) => { needLogin(b); return withAuth(b, () => b.info.getEleRemainder()); });
reg("ele-records", async (b) => { needLogin(b); return withAuth(b, () => b.info.getElePayRecord()); });
reg("net-info", async (b) => { needLogin(b); return withAuth(b, () => b.info.getNetworkAccountInfo()); });
reg("net-balance", async (b) => { needLogin(b); return withAuth(b, () => b.info.getNetworkBalance()); });
reg("net-devices", async (b) => { needLogin(b); return withAuth(b, () => b.info.getOnlineDevices()); });

/* ── 网络学堂（读） ── */

reg("learn-semesters", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.learn.getSemesterIdList());
});

async function currentSemesterId(b: Boot): Promise<string> {
  const sem: any = await b.learn.getCurrentSemester().catch(() => null);
  const id = String(sem?.id ?? sem?.semesterId ?? "");
  if (id) return id;
  const list: any[] = await b.learn.getSemesterIdList().catch(() => []);
  return list.length ? String(list[list.length - 1]) : "";
}

reg("learn-courses", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const sid = a?.semester ? String(a.semester) : await currentSemesterId(b);
    return b.learn.getCourseList(sid);
  });
});

reg("learn-homework", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const courses: any[] = await (commands["learn-courses"] as Cmd)(b, a) as any;
    const ids = courses.map((c) => String(c.id ?? c.wlkcid ?? "")).filter(Boolean);
    return b.learn.getAllHomework(ids);
  });
});

reg("learn-homework-detail", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.learn.getHomeworkDetail(String(a.id)));
});

reg("learn-homework-page", async (b, a) => {
  needLogin(b);
  if (!a?.courseId || !a?.id) fail("需要 courseId 和 id（作业列表项的 id）");
  return withAuth(b, () => b.learn.getHomeworkPageDetail(
    String(a.courseId), String(a.id)));
});

const MIME: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip", rar: "application/vnd.rar",
  txt: "text/plain", md: "text/markdown",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
};

reg("learn-homework-submit", async (b, a) => {
  needLogin(b);
  const id = String(a?.id ?? "").trim();
  if (!id) fail("需要 id（作业列表项的 id，即 studentHomeworkId）");
  // 写操作：绝不自动重试（直接调，不包 withAuth 的读重试语义；
  // submitHomework 内部的 #withRelogin 只在「未登录」时续期一次）
  const file = a?.file ? String(a.file) : "";
  const buf = file ? await readFile(file) : null;
  const name = file ? basename(file) : "";
  const f = buf ? new File([buf], name, { type: MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream" }) : null;
  const r = await b.learn.submitHomework(id, {
    content: a?.content == null ? "" : String(a.content),
    file: f,
    remove: !!a?.remove,
  });
  if (!r.ok) fail(r.msg || "提交失败", b.learn.lastDebug);
  return { submitted: true, attachment: !!f, removed: !!a?.remove };
});

reg("learn-notifications", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const courses: any[] = await (commands["learn-courses"] as Cmd)(b, a) as any;
    const ids = courses.map((c) => String(c.id ?? c.wlkcid ?? "")).filter(Boolean);
    return b.learn.getAllNotifications(ids, !!a?.expired);
  });
});

reg("learn-notification-detail", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.learn.getNotificationPageDetail(
    String(a.courseId), String(a.notificationId)));
});

reg("learn-files", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.learn.getFileList(String(a.courseId)));
});

reg("learn-calendar", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.learn.getCalendarData());
});

/* ── 图书馆（座位系统） ── */

reg("lib-list", async (b) => { needLogin(b); return withAuth(b, () => b.info.getLibraryList()); });

reg("lib-floors", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const list: any[] = await b.info.getLibraryList();
    const lib = list.find((l) => String(l.id) === String(a.libraryId)) ?? list[0];
    if (!lib) throw new Error("图书馆列表为空");
    return b.info.getLibraryFloorList(lib, a?.dateChoice === 1 ? 1 : 0);
  });
});

reg("lib-sections", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const floors: any[] = await (commands["lib-floors"] as Cmd)(b, a) as any;
    const floor = floors.find((f) => String(f.id) === String(a.floorId));
    if (!floor) throw new Error(`没有 #${a.floorId} 这个楼层（用 lib-floors 查看）`);
    return b.info.getLibrarySectionList(floor, a?.dateChoice === 1 ? 1 : 0);
  });
});

reg("lib-seats", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const sections: any[] = await (commands["lib-sections"] as Cmd)(b, a) as any;
    const sec = sections.find((s: any) => String(s.id) === String(a.sectionId));
    if (!sec) throw new Error(`没有 #${a.sectionId} 这个区域（用 lib-sections 查看）`);
    return b.info.getLibrarySeatList(sec, a?.dateChoice === 1 ? 1 : 0);
  });
});

reg("lib-book", async (b, a) => {
  needLogin(b);
  // 写操作：绝不自动重试
  return withAuth(b, () => b.info.bookLibrarySeat(
    { id: Number(a.seatId) }, Number(a.sectionId), a?.dateChoice === 1 ? 1 : 0,
    b.session.username,
  ), false);
});

reg("lib-records", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.info.getLibBookRecords());
});

reg("lib-cancel", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.cancelLibBooking(String(a.recordId), b.session.username), false);
});

reg("libroom-info", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.info.getLibRoomInfoList(b.session.username));
});

reg("libroom-res", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getLibRoomResourceList(
    b.session.username, String(a.date), Number(a.kindId ?? 0)));
});

reg("libroom-book", async (b, a) => {
  needLogin(b);
  return withAuth(b, async () => {
    const res: any[] = await b.info.getLibRoomResourceList(
      b.session.username, String(a.date), Number(a.kindId ?? 0));
    const room = res.find((r) => String(r.id ?? r.resId) === String(a.resId));
    if (!room) throw new Error(`没有 #${a.resId} 这个资源（用 libroom-res 查看）`);
    return b.info.bookLibRoom(
      b.session.username, room, String(a.start), String(a.end),
      (a.members ?? []).map((x: any) => Number(x)));
  }, false);
});

reg("libroom-records", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.info.getLibRoomRecords(b.session.username));
});

reg("libroom-cancel", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.cancelLibRoomBooking(b.session.username, String(a.uuid)), false);
});

/* ── 体育（旧系统：查询 / 退订；预约提交按校规不提供） ── */

reg("sports-id", async () => (core as any).sportsIdInfoList);

reg("sports-resources", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.getSportsResources(
    String(a.gymId), String(a.itemId), String(a.date)));
});

reg("sports-records", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.info.getSportsReservationRecords());
});

reg("sports-cancel", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.unsubscribeSportsReservation(String(a.bookId)), false);
});

/* ── 宿舍公共空间（共享家园） ── */

reg("kongjian-page", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.kongjianPage({
    spaceId: a?.spaceId, roomId: a?.roomId, date: a?.date,
  }));
});

reg("kongjian-book", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.kongjianBook(String(a.bookUrl), {
    name: String(a.name ?? ""), sid: String(a.sid ?? ""),
    tel: String(a.tel ?? ""), other: String(a.other ?? ""),
  }), false);
});

reg("kongjian-my", async (b) => {
  needLogin(b);
  return withAuth(b, () => b.info.kongjianMy());
});

reg("kongjian-cancel", async (b, a) => {
  needLogin(b);
  return withAuth(b, () => b.info.kongjianCancel(String(a.target)), false);
});

/* ── 选课（zhjwxk） ── */

reg("xk-semester", async (b) => withAuth(b, () => core.resolveZhjwxkSemester(xkSession(b))));

reg("xk-selected", async (b, a) => {
  return withAuth(b, () => core.getSelectedCourses(xkSession(b), { semester: a?.semester }));
});

reg("xk-queue", async (b, a) => {
  return withAuth(b, () => core.getQueueStatus(xkSession(b), { semester: a?.semester }));
});

reg("xk-catalog", async (b, a) => {
  return withAuth(b, () => core.getXkCatalog(xkSession(b), { semester: a?.semester }));
});

reg("xk-search", async (b, a) => {
  return withAuth(b, () => core.searchXkCourses(xkSession(b), {
    semester: a?.semester, page: a?.page, kch: a?.kch, kcm: a?.kcm,
  }));
});

reg("xk-submit", async (b, a) => {
  return withAuth(b, () => core.submitXkCourse(xkSession(b), {
    semester: a?.semester, code: String(a.code), seq: String(a.seq),
    zy: Number(a.zy), flag: a.flag,
  }), false);
});

reg("xk-drop", async (b, a) => {
  return withAuth(b, () => core.dropXkCourse(xkSession(b), {
    semester: a?.semester, code: String(a.code), seq: String(a.seq),
    isQueue: !!a.isQueue,
  }), false);
});

reg("xk-volunteer", async (b, a) => {
  return withAuth(b, () => core.changeXkVolunteer(xkSession(b), {
    semester: a?.semester, code: String(a.code), seq: String(a.seq), zy: Number(a.zy),
  }), false);
});

/* ── 免登录公共能力 ── */

reg("washer-buildings", async () => core.getWasherBuildingGroups(makeFetchLike(() => null)));

reg("washer-devices", async (b, a) => {
  const groups = await core.getWasherBuildingGroups(makeFetchLike(() => null));
  let building: any = null;
  for (const g of groups) {
    building = (g.buildings ?? []).find((x: any) => String(x.id) === String(a.buildingId));
    if (building) break;
  }
  if (!building) throw new Error(`没有 #${a.buildingId} 这栋楼（用 washer-buildings 查看）`);
  return core.getWasherDevices(makeFetchLike(() => null), building);
});

reg("coursex-semesters", async () => core.getCourseXSemesters(makeFetchLike(() => null)));

reg("coursex-search", async (b, a) => {
  return core.searchCourseXPublic(makeFetchLike(() => null), String(a.query ?? ""), a?.semester);
});

reg("coursex-detail", async (b, a) => {
  return core.getCourseXDetailPublic(makeFetchLike(() => null), String(a.id));
});

/* ── 自检（免登录） ── */

reg("selftest", async () => {
  const host = (core as any).webvpn.encryptHost("zhjw.cic.tsinghua.edu.cn");
  const expect = "77726476706e69737468656265737421eaff4b8b69336153301c9aa596522b20bc86e6e559a9b290";
  const url = "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do?m=1";
  const wrapped = core.webvpnEncodeUrl(url);
  const roundtrip = core.webvpnDecodeUrl(wrapped) === url;
  let coursex: any = null;
  try {
    coursex = (await core.getCourseXSemesters(makeFetchLike(() => null))).length + " semesters";
  } catch (e) {
    coursex = "unreachable: " + (e instanceof Error ? e.message : e);
  }
  return { hostCodec: host === expect, urlRoundtrip: roundtrip, coursex };
});

/* ── 入口 ── */

async function main(): Promise<void> {
  const cmdName = process.argv[2] ?? "";
  const cmd = commands[cmdName];
  if (!cmd) {
    fail("未知命令 " + cmdName + "。可用：" + [...commands.keys()].join(" / "));
  }
  let args: any = {};
  if (process.argv[3]) {
    try { args = JSON.parse(process.argv[3]); } catch { fail("参数不是合法 JSON"); }
  }
  if (cmdName === "login") {
    // 密码走 stdin，不进进程列表：首个非空行 = {"username","password","remember"}。
    // 逐行读（不等到 EOF）——同一管道随后继续送 2FA 指令行（网页/脚本驱动必需）
    const first: string = await new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin });
      let h: ReturnType<typeof setTimeout> | undefined;
      const done = (v: string) => { if (h) clearTimeout(h); resolve(v); };
      h = setTimeout(() => { rl.close(); done(""); }, 120_000);
      rl.on("line", (l: string) => {
        const t = l.trim();
        if (!t) return;
        done(t);  // 先 resolve 再 close：input 已 EOF 时 close 会同步派发
        rl.close();
      });
      rl.on("close", () => done(""));
    });
    if (!first) fail("stdin 无凭据输入（首行应为 JSON）");
    try { args = { ...args, ...JSON.parse(first) }; } catch { fail("stdin JSON 不合法"); }
  }
  const b = boot(await loadSecret());
  if (!["login", "status", "logout"].includes(cmdName)) {
    await revive(b);
  }
  try {
    const data = await cmd(b, args);
    emit({ ok: true, data });
  } catch (err) {
    const e = err as any;
    emit({
      ok: false,
      error: e?.message ?? String(err),
      ...(e?.detail ? { detail: String(e.detail).slice(0, 2000) } : {}),
      ...(e?.debug ? { debug: String(e.debug).slice(0, 2000) } : {}),
    });
    process.exit(1);
  }
}

void main();
