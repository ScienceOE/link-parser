// Functional test harness for the link-parser skill extractors.
// Loads real pages with Playwright Chromium, injects the extractor function
// from references/<platform>.md, and saves the returned JSON per platform.
//
// 与 ci-run.mjs 共用 classify.mjs，因此本脚本同样有断言与退出码语义
// （此前它只写 JSON、永远退出 0，无法当回归门禁）。
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExtractorSource } from "./extractors.mjs";
import { classify, looksAntiBot, renderSummary, summarize, describeResult } from "./classify.mjs";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(OUT_DIR, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// platform, url, waitMs (per reference "等待条件"), extractor arg, 断言元数据
const TESTS = [
  { platform: "bilibili", url: "https://www.bilibili.com/video/BV1GJ411x7h7/", waitMs: 1000, arg: "BV1GJ411x7h7", expect: "parse", contentSelector: "#app" },
  { platform: "douyin", url: process.env.DOUYIN_URL || "DOUYIN_DISCOVERED", waitMs: Number(process.env.DOUYIN_WAIT || 5000), expect: "parse", contentSelector: "h1" },
  { platform: "wechat", url: "https://mp.weixin.qq.com/s/jKFtBtP5MXB95GBBFrpF4w", waitMs: 2500, expect: "parse", expectAuthor: true, contentSelector: "#js_content" },
  { platform: "toutiao", url: "https://www.toutiao.com/article/7127948627590349344/", waitMs: 3000, expect: "parse", expectAuthor: true, contentSelector: ".syl-article-base" },
  { platform: "zhihu", url: "https://www.zhihu.com/question/14300164636/answer/1896645253802475779", waitMs: 3000, expect: "parse", contentSelector: ".AnswerItem, .Post-RichTextContainer" },
  { platform: "generic", url: "https://en.wikipedia.org/wiki/Large_language_model", waitMs: 2000, expect: "parse" },
];

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

async function main() {
  const only = process.argv[2]; // optional: run a single platform
  const launchOpts = process.env.BROWSER === "chrome" ? { channel: "chrome", headless: true } : {};
  const browser = await chromium.launch(launchOpts);
  const rows = [];

  for (const t of TESTS) {
    if (only && t.platform !== only) continue;
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    let url = t.url;
    const record = { platform: t.platform, requestedUrl: url, startedAt: new Date().toISOString() };
    const ev = { navigationError: undefined, httpStatus: null, antiBot: false, contentPresent: undefined };

    try {
      if (url === "DOUYIN_DISCOVERED") {
        // Douyin has no stable public deep-link indexed by search; discover one live:
        // open the web home feed, scroll to render feed cards, take the first /video/ href.
        await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
        let href = "";
        for (let i = 0; i < 6 && !href; i++) {
          await page.waitForTimeout(2500);
          await page.mouse.wheel(0, 1500);
          href = await page.evaluate(() => {
            const a = Array.from(document.querySelectorAll('a[href*="/video/"]'))
              .map(a => a.href)
              .find(h => /douyin\.com\/video\/\d+/.test(h));
            return a || "";
          });
        }
        if (!href) throw new Error("could not discover a /video/ link from douyin.com feed");
        record.discoveredFrom = "https://www.douyin.com/ feed";
        url = href;
        record.finalUrl = url;
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        ev.httpStatus = resp ? resp.status() : null;
        await page.waitForTimeout(t.waitMs);
      } else {
        try {
          const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          ev.httpStatus = resp ? resp.status() : null;
        } catch (e) {
          ev.navigationError = String(e?.message || e).slice(0, 120);
        }
        if (!ev.navigationError) {
          await page.waitForTimeout(t.waitMs);
          record.finalUrl = page.url();
        }
      }

      if (!ev.navigationError) {
        record.pageTitle = await page.title();

        // 页面级拦截证据（反爬 JSON / 风控文案 / 内容容器是否真的存在）
        try {
          const text = await evaluateWithRetry(page, `() => (document.body ? document.body.innerText || "" : "").slice(0, 5000)`);
          ev.antiBot = looksAntiBot(text);
        } catch (e) { /* 跳转中取不到，留 undefined */ }
        if (t.contentSelector) {
          try {
            ev.contentPresent = await page.evaluate((sel) => !!document.querySelector(sel), t.contentSelector);
          } catch (e) { /* 忽略 */ }
        }

        // login-wall / captcha detection (informational, per SKILL.md stop rule)
        record.pageChecks = await evaluateWithRetry(page, `() => {
          const text = document.body?.innerText?.slice(0, 2000) || "";
          const href = location.href;
          return {
            urlHasLoginMarker: /passport|login|captcha/i.test(href),
            bodyHasLoginMarker: /请登录|扫码登录|安全验证|滑块|拖动滑块/.test(text),
            hasCaptchaDom: !!document.querySelector("#captcha, [id*='captcha'], [class*='captcha']"),
            textHead: text.slice(0, 200),
          };
        }`);

        const src = getExtractorSource(t.platform);
        try {
          const expr = t.platform === "bilibili" ? `(${src})("${t.arg}")` : `(${src})()`;
          record.extractorReturned = await evaluateWithRetry(page, expr);
          record.extractorThrew = false;
        } catch (e) {
          record.extractorThrew = true;
          record.extractorError = String(e && e.message || e);
        }
      }
    } catch (e) {
      record.navigationError = String(e && e.message || e);
      ev.navigationError = ev.navigationError || record.navigationError.slice(0, 120);
    }

    record.httpStatus = ev.httpStatus;
    record.antiBot = ev.antiBot;
    record.contentPresent = ev.contentPresent;
    record.status = record.extractorThrew
      ? "EXTRACTOR_FAIL"
      : classify(t, record.extractorReturned || null, ev);
    record.detail = record.extractorThrew
      ? "extractor threw: " + String(record.extractorError).slice(0, 120)
      : ev.navigationError
        ? "nav: " + ev.navigationError
        : describeResult(record.extractorReturned || null);

    writeFileSync(path.join(OUT_DIR, `${t.platform}.json`), JSON.stringify(record, null, 2));
    rows.push({ name: t.platform, status: record.status, detail: record.detail });
    console.log(`${record.status}  ${t.platform}  ${record.detail}`);
    await ctx.close();
  }

  await browser.close();

  const { nBlocked, nFail } = summarize(rows);
  console.log("\n" + renderSummary(rows, "link-parser run-tests 结果"));
  if (nFail > 0) {
    console.log(`\nrun-tests: ${nFail} extractor failure(s)`);
    process.exit(1);
  }
  console.log(`\nrun-tests done: ${nBlocked} blocked (warning), 0 failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
