// 回归测试共享分类器 —— ci-run.mjs 与 run-tests.mjs 共用同一套判定，
// 避免"同仓库两套脚本判定不一致、CI 偏偏用了最脆的那个"。
//
// 三档语义（与 README / test-links.md 保持一致）：
//   PASS           — 正向：无 error 且 title 非空（声明 expectAuthor 时 author 也须非空）；
//                    反向：返回预期集合中的具体 error 码。
//   BLOCKED        — 有平台级拦截证据，属环境限制，计警告不 fail：
//                      ① 导航失败/超时/连接级错误
//                      ② HTTP 401/403/412/429/451/503
//                      ③ 响应正文是反爬 JSON 或风控文案
//                      ④ 提取器已返回 error，且页面确实缺少该平台的内容容器（未登录/未水合）
//   EXTRACTOR_FAIL — 其余一切：提取器抛异常、正向拿到 error/空 title、
//                    反向拿不到预期 error 码。只有这一档会让 runner 以非零码退出。
//
// 关键取舍：BLOCKED 只认"证据"，不是"拿不到就算环境问题"。正向用例在内容容器
// 存在的页面上仍必须真的解析出数据，否则照样 EXTRACTOR_FAIL —— 修复不会掩盖真实回归。

export const HARD_BLOCK_STATUS = new Set([401, 403, 412, 429, 451, 503]);

// 反爬/风控特征：知乎 40362 JSON、B站风控页、通用验证文案
export const ANTI_BOT_RE =
  /40362|您当前请求存在异常|暂时限制本次访问|安全验证|访问过于频繁|请完成验证|验证后继续|拖动滑块/;

/**
 * @param {object} c   用例定义 {expect:'parse'|'error', expectedErrors?:string[], expectAuthor?:boolean}
 * @param {object} r   提取器返回值
 * @param {object} ev  页面证据 {navigationError?, httpStatus?, antiBot?, contentPresent?}
 *                     contentPresent: 用例声明了 contentSelector 时才有值（false = 容器确实不存在）
 * @returns {'PASS'|'BLOCKED'|'EXTRACTOR_FAIL'}
 */
export function classify(c, r, ev = {}) {
  // 1) 期望结果达成 → PASS（优先于 BLOCKED：反向用例正确触发守卫仍是有效信号）
  if (c.expect === "parse") {
    if (r && !r.error && r.title) {
      if (c.expectAuthor && !(r.author && r.author.name)) return "EXTRACTOR_FAIL";
      return "PASS";
    }
  } else if (r && r.error && (c.expectedErrors || []).includes(r.error)) {
    return "PASS";
  }

  // 2) 平台级拦截证据 → BLOCKED
  if (isBlocked(r, ev)) return "BLOCKED";

  // 3) 其余 → 提取器自身问题
  return "EXTRACTOR_FAIL";
}

export function isBlocked(r, ev = {}) {
  if (ev.navigationError) return true;
  if (ev.httpStatus && HARD_BLOCK_STATUS.has(Number(ev.httpStatus))) return true;
  if (ev.antiBot) return true;
  // 提取器老实报了错，且页面确实没有该平台的内容容器 → 未登录/未水合，属环境
  if (r && r.error && ev.contentPresent === false) return true;
  return false;
}

/** 从页面文本判定是否命中反爬/风控特征 */
export function looksAntiBot(text) {
  const t = text || "";
  return ANTI_BOT_RE.test(t) || /^\s*\{\s*"error"\s*:/.test(t.trim());
}

/** 汇总 + 退出码语义 */
export function summarize(rows) {
  const nFail = rows.filter((r) => r.status === "EXTRACTOR_FAIL").length;
  const nBlocked = rows.filter((r) => r.status === "BLOCKED").length;
  return { nPass: rows.length - nFail - nBlocked, nBlocked, nFail };
}

/** 生成与 CI job summary / 控制台一致的 markdown */
export function renderSummary(rows, title = "link-parser 提取器回归结果") {
  const { nPass, nBlocked, nFail } = summarize(rows);
  return [
    `# ${title}`,
    ``,
    `| 用例 | 结果 | 明细 |`,
    `|---|---|---|`,
    ...rows.map((r) => `| ${r.name} | ${r.status} | ${r.detail || ""} |`),
    ``,
    `**通过 ${nPass} / 阻塞(BLOCKED，环境限制) ${nBlocked} / 失败 ${nFail}**`,
    ``,
    `BLOCKED = 有平台级拦截证据（导航失败/超时、HTTP 403/412/429 等、反爬正文、内容容器确实缺失），不计为失败；`,
    `EXTRACTOR_FAIL = 提取器自身问题（抛异常、正向拿到 error/空 title、反向拿不到预期 error 码），会导致本 job 失败。`,
  ].join("\n");
}

/** 正向用例统一断言：是否拿到了真实可用的标题 */
export function describeResult(r) {
  if (!r) return "(no result)";
  if (r.error) return `error=${r.error}`;
  return `title="${(r.title || "").slice(0, 50)}"`;
}
