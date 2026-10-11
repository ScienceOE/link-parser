// 分类器单元测试（纯 Node，不需要浏览器，秒级）。
// 目的：证明"放宽 BLOCKED"没有把真实回归洗成环境问题 —— 内容容器存在时
// 提取器出错仍必须 EXTRACTOR_FAIL。同时锁定反爬特征识别。
import { classify, looksAntiBot, summarize } from "./classify.mjs";

let failures = 0;
function eq(name, got, want) {
  if (got === want) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name} :: got=${got} want=${want}`); }
}

const PARSE = { expect: "parse" };
const PARSE_AUTHOR = { expect: "parse", expectAuthor: true };
const NEG = { expect: "error", expectedErrors: ["NO_STATE"] };
const okResult = { title: "真实标题", author: { name: "作者" } };

// --- 正向用例 ---
eq("正向拿到数据 → PASS", classify(PARSE, okResult, { httpStatus: 200 }), "PASS");
eq("正向缺 author（声明了 expectAuthor）→ FAIL", classify(PARSE_AUTHOR, { title: "t" }, { httpStatus: 200 }), "EXTRACTOR_FAIL");
eq("正向只有 error、但内容容器存在 → 绝不放行", classify(PARSE, { error: "NO_CONTENT" }, { httpStatus: 200, contentPresent: true }), "EXTRACTOR_FAIL");
eq("正向只有 error、内容容器不存在（未水合）→ BLOCKED", classify(PARSE, { error: "NO_CONTENT" }, { httpStatus: 200, contentPresent: false }), "BLOCKED");
eq("正向 HTTP 403 → BLOCKED", classify(PARSE, { error: "NO_ANSWER" }, { httpStatus: 403, contentPresent: true }), "BLOCKED");
eq("正向反爬正文 → BLOCKED", classify(PARSE, { error: "NO_ANSWER" }, { httpStatus: 200, antiBot: true, contentPresent: true }), "BLOCKED");
eq("正向导航失败 → BLOCKED", classify(PARSE, null, { navigationError: "Timeout 60000ms" }), "BLOCKED");
eq("正向空 title 且无 error → FAIL（空壳不得算成功）", classify(PARSE, { title: "" }, { httpStatus: 200 }), "EXTRACTOR_FAIL");

// --- 反向用例 ---
eq("反向命中预期 error → PASS", classify(NEG, { error: "NO_STATE" }, { httpStatus: 200 }), "PASS");
eq("反向拿到非预期 error → FAIL", classify(NEG, { error: "NO_CONTENT" }, { httpStatus: 200 }), "EXTRACTOR_FAIL");
eq("反向没有任何结果 → FAIL", classify(NEG, null, { httpStatus: 200 }), "EXTRACTOR_FAIL");
eq("反向导航失败 → BLOCKED", classify(NEG, null, { navigationError: "ECONNRESET" }), "BLOCKED");

// --- 反爬特征识别 ---
eq("antiBot: 知乎 40362 JSON", looksAntiBot('{"error":{"message":"您当前请求存在异常，暂时限制本次访问。","code":40362}}'), true);
eq("antiBot: 通用 JSON error 前缀", looksAntiBot('  {"error":{"code":1}}'), true);
eq("antiBot: B站风控文案", looksAntiBot("请完成安全验证后继续访问"), true);
eq("antiBot: 正常文章正文", looksAntiBot("这是一篇正常的文章正文，讨论经济与人口。"), false);

// --- 汇总语义 ---
const s = summarize([
  { status: "PASS" }, { status: "PASS" }, { status: "BLOCKED" }, { status: "EXTRACTOR_FAIL" },
]);
eq("summarize 统计", `${s.nPass}/${s.nBlocked}/${s.nFail}`, "2/1/1");

console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nAll classify assertions passed");
process.exit(failures ? 1 : 0);
