// CI regression runner: executes the extractors from references/ against the
// test-links.md link set with Playwright's bundled Chromium, classifies each
// result and writes a GitHub Actions job summary.
//
// 分类逻辑统一放在 classify.mjs（与 run-tests.mjs 共用），本文件只负责取页面证据。
// Exit code: 0 unless at least one EXTRACTOR_FAIL.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExtractorSource } from "./extractors.mjs";
import { classify, looksAntiBot, renderSummary, summarize, describeResult } from "./classify.mjs";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(OUT_DIR, { recursive: true });

// SPA 在 evaluate 期间会客户端重载，导致 "Execution context was destroyed"。
// 这是导航竞态，不是提取器 bug —— run-tests.mjs 一直有重试，ci-run 此前是裸调用，
// 结果把竞态误判成 EXTRACTOR_FAIL（真实 CI 日志里 bilibili-not-found 就是这么红的）。
async function evaluateWithRetry(page, expression, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.evaluate(expression);
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(800);
    }
  }
  throw lastErr;
}

// 与 references/test-links.md 保持一致
// contentSelector：该平台"页面已渲染出内容"的判定锚点；提取器报错且该锚点不存在
//                  → 判 BLOCKED（未登录/未水合），而不是提取器 bug。
const CASES = [
  { name: "bilibili", url: "https://www.bilibili.com/video/BV1GJ411x7h7/", platform: "bilibili", arg: "BV1GJ411x7h7", waitMs: 1000, expect: "parse", contentSelector: "#app" },
  { name: "bilibili-not-found", url: "https://www.bilibili.com/video/BV1aa411a7aa/", platform: "bilibili", arg: "BV1aa411a7aa", waitMs: 1000, expect: "error", expectedErrors: ["NO_STATE", "WALL"], contentSelector: "#app" },
  { name: "douyin", url: process.env.DOUYIN_URL || "https://www.douyin.com/video/7519882634554543379", platform: "douyin", waitMs: 6000, expect: "parse", contentSelector: "h1" },
  { name: "douyin-deleted", url: "https://www.iesdouyin.com/share/video/6883418578486349070/", platform: "douyin", waitMs: 6000, expect: "error", expectedErrors: ["VIDEO_NOT_FOUND"], contentSelector: "h1" },
  { name: "wechat", url: "https://mp.weixin.qq.com/s/jKFtBtP5MXB95GBBFrpF4w", platform: "wechat", waitMs: 3000, expect: "parse", expectAuthor: true, contentSelector: "#js_content" },
  { name: "toutiao", url: "https://www.toutiao.com/article/7127948627590349344/", platform: "toutiao", waitMs: 4000, expect: "parse", expectAuthor: true, contentSelector: ".syl-article-base" },
  { name: "zhihu", url: "https://www.zhihu.com/question/14300164636/answer/1896645253802475779", platform: "zhihu", waitMs: 4000, expect: "parse", contentSelector: ".AnswerItem, .Post-RichTextContainer" },
  { name: "zhihu-not-found", url: "https://www.zhihu.com/question/99999999999", platform: "zhihu", waitMs: 4000, expect: "error", expectedErrors: ["NO_ANSWER", "NO_CONTENT"], contentSelector: ".AnswerItem, .Post-RichTextContainer" },
  { name: "generic", url: "https://en.wikipedia.org/wiki/Large_language_model", platform: "generic", waitMs: 2000, expect: "parse" },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const rows = [];
  const results = {};

  for (const c of CASES) {
    const rec = { url: c.url };
    const ev = { navigationError: undefined, httpStatus: null, antiBot: false, contentPresent: undefined };
    let r = null;
    let status;
    let detail = "";

    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    try {
      let resp = null;
      try {
        resp = await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        ev.httpStatus = resp ? resp.status() : null;
      } catch (e) {
        // 导航失败/超时/连接级错误 = 环境阻塞
        ev.navigationError = String(e?.message || e).slice(0, 120);
      }

      if (!ev.navigationError) {
        await page.waitForTimeout(c.waitMs);
        try {
          const text = await page.evaluate(() => (document.body ? document.body.innerText || "" : "").slice(0, 5000));
          ev.antiBot = looksAntiBot(text);
        } catch (e) {
          rec.evidenceError = String(e?.message || e).slice(0, 120);
        }
        if (c.contentSelector) {
          try {
            ev.contentPresent = await page.evaluate((sel) => !!document.querySelector(sel), c.contentSelector);
          } catch (e) {
            /* 页面跳转中取不到锚点，视为未观测（undefined）*/
          }
        }
        try {
          const src = getExtractorSource(c.platform);
          const expr = c.arg ? `(${src})("${c.arg}")` : `(${src})()`;
          r = await evaluateWithRetry(page, expr);
        } catch (e) {
          // 重试后仍抛异常 = 提取器 bug（即便页面被拦也不该抛，契约要求返回 ErrorResult）
          rec.status = "EXTRACTOR_FAIL";
          rec.detail = "extractor threw: " + String(e?.message || e).slice(0, 120);
          results[c.name] = rec;
          rows.push({ name: c.name, status: rec.status, detail: rec.detail });
          console.log(`${rec.status}  ${c.name}  ${rec.detail}`);
          await ctx.close().catch(() => {});
          continue;
        }
      }

      rec.httpStatus = ev.httpStatus;
      rec.antiBot = ev.antiBot;
      rec.contentPresent = ev.contentPresent;
      rec.result = r;
      status = classify(c, r, ev);
      rec.status = status;
      detail = ev.navigationError ? "nav: " + ev.navigationError : describeResult(r);
      if (status === "BLOCKED" && !ev.navigationError) {
        detail += `  [blocked: http=${ev.httpStatus ?? "-"} antiBot=${ev.antiBot} content=${ev.contentPresent}]`;
      }
      rec.detail = detail;
    } catch (e) {
      // harness 自身异常按提取器失败计（避免假绿）
      rec.status = "EXTRACTOR_FAIL";
      rec.detail = "harness: " + String(e?.message || e).slice(0, 120);
    } finally {
      await ctx.close().catch(() => {});
    }

    if (!rec.status) {
      rec.status = classify(c, r, ev);
      rec.detail = rec.detail || describeResult(r);
    }
    results[c.name] = rec;
    rows.push({ name: c.name, status: rec.status, detail: rec.detail || "" });
    console.log(`${rec.status}  ${c.name}  ${rec.detail || ""}`);
  }
  await browser.close();

  writeFileSync(path.join(OUT_DIR, "ci-run.json"), JSON.stringify(results, null, 2));

  const { nBlocked, nFail } = summarize(rows);
  const summary = renderSummary(rows);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } else {
    console.log("\n" + summary);
  }

  if (nFail > 0) process.exit(1);
  console.log(`\nCI regression done: ${nBlocked} blocked (warning), 0 failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
