#!/usr/bin/env node
// i18n 覆盖率自检（英文表）
//
// 设计前提见 src/lib/i18n.ts：**中文原文当键**，查不到就原样显示中文 —— 好处是
// 漏翻不会白屏、也不会崩，代价是**编译器完全看不见漏翻**。这个脚本就是那双眼睛。
//
// 三类会被它抓出来的问题：
//   ① 界面缺失：tr("中文") 的键不在 EN_US 里 → 英文界面显示中文
//   ② 界面放错表：键写在 EN_US_BACKEND 里 → tr() 只读 EN_US，写了也查不到（踩过）
//   ③ 后端缺失：Rust 错误/状态路径的中文消息不在 EN_US_BACKEND 里 → 英文界面弹中文
// 另外单独提示「孤儿词条」（EN_US 里没人用的键）：源码中文改过 → 译文失效，
// 留在表里无害，但值得顺手清掉或改成新键。
//
// 只管「会走到用户眼前」的字符串：日志（tracing/println）、注释、测试不参与判定。
//
// 用法：node scripts/i18n-audit.mjs      （有 ①②③ 时退出码 1）
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCALE = path.join(ROOT, "src/locales/en-US.ts");

// ---------------------------------------------------------------- 词条表

const localeSrc = fs.readFileSync(LOCALE, "utf8");
const iBackend = localeSrc.indexOf("export const EN_US_BACKEND");
if (iBackend < 0) throw new Error("en-US.ts: 找不到 EN_US_BACKEND");

/** 取一张表（表边界 = 下一个 `export const` 或文件尾）；值也要，用于镜像漂移比对 */
function tableOf(body) {
  const out = new Map();
  for (const m of body.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:\s*\n?\s*("(?:[^"\\]|\\.)*")/gm)) {
    out.set(JSON.parse(m[1]), JSON.parse(m[2]));
  }
  return out;
}
const uiTable = tableOf(localeSrc.slice(0, iBackend));
const backendTable = tableOf(localeSrc.slice(iBackend));
const UI = new Set(uiTable.keys());
const BACKEND = new Set(backendTable.keys());

// ---------------------------------------------------------------- 源码扫描

const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

/** Rust 字符串字面量的转义还原（\n \" \\ 与 JSON 同形；行尾 `\`+换行 = 续行拼接；
 *  format! 里的 `{{`/`}}` 渲染成单个花括号 —— 键要写**渲染后**的样子） */
function unescapeRs(raw) {
  const joined = raw.replace(/\\\r?\n[ \t]*/g, ""); // Rust 续行：反斜杠 + 换行 + 缩进全部去掉
  const brace = joined.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
  try {
    return JSON.parse(`"${brace}"`);
  } catch {
    return brace.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** 全文扫描（跨行的 tr( / format! 都能命中），把 match.index 换成行号 */
function scan(file, re, onMatch) {
  const text = fs.readFileSync(file, "utf8");
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  for (const m of text.matchAll(re)) onMatch(m, lineAt(m.index), text);
}

function walk(dir, exts, skip = []) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.includes(e.name)) out.push(...walk(p, exts, skip));
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

// ---- 前端：tr("…") / trMsg("…") 的第一参数（字面量） ----
// tr() 只查 EN_US；trMsg() 先查 EN_US 再查 EN_US_BACKEND —— 所以 tr 的键必须在
// EN_US 里，trMsg 的键两张表任一即可。
const trUsed = new Map();    // key → 首个出现位置
const trMsgUsed = new Map();
const callRe = /\b(tr|trMsg)\(\s*(["'`])((?:\\[\s\S]|(?!\2)[\s\S])*?)\2/g;
for (const file of walk(path.join(ROOT, "src"), [".ts", ".tsx"], ["locales"])) {
  const rel = path.relative(ROOT, file);
  scan(file, callRe, (m, lineNo) => {
    const lit = m[3];
    if (!hasCJK(lit) || lit.includes("${")) return; // 模板插值不是键
    const key = JSON.parse(`"${lit.replace(/\\`/g, "`").replace(/"/g, '\\"')}"`);
    const bucket = m[1] === "tr" ? trUsed : trMsgUsed;
    if (!bucket.has(key)) bucket.set(key, `${rel}:${lineNo}`);
  });
}

// ---- 后端：Rust 错误/状态路径的中文消息（i18n::tr 的键归 Rust 自己的目录，不算） ----
// 判据 = 「这条字符串所在语句看起来在造给用户看的东西」；日志/注释/测试直接跳过。
// 逐个字符走一遍（注释/raw string 里的引号不能参与配对，否则一条注释里的引号会跟
// 几百行外的引号配成一条假消息 —— 踩过）。
const backendMissing = new Map();

// 会到用户眼前的形状：错误构造 / match 分支映射 / 拼消息 / 状态与 JSON 载荷 / 校验错误
// （`=>` 与 `.into()` 是「match 里映射文案」这一类的特征 —— 用户报的
//  「更新清单不存在（新版本可能正在发布中）」 就是这种形状，早先的规则漏掉了）
const VISIBLE_SHAPE = /\b(Err|bail|ensure|map_err|ok_or)\b|format!|=>|\.into\(\)|\.to_string\(\)|unwrap_or\(|\.push\(|json!\(|"error"|\breturn\b/;
// 明确不判的：
//  - 日志/诊断标签（mem_watch::report 的 tag、auto_pause 的 reason 都只进 tracing）
//  - 开发期断言（.expect/assert/panic 的文案是给改代码的人看的）
//  - 访客页 HTML 模板、SQL 语句（里面的中文是 SQL 注释/字面量，不是界面文案；
//    真要显示的值（如 error_msg）会作为独立字符串出现在别处）
const NOT_VISIBLE_SHAPE = /tracing::|println!|eprintln!|log::|i18n::tr\(|\breport\(|debug_assert|assert!|unreachable!|panic!|\.expect\(|<html|<\/|class=|INSERT INTO|UPDATE |SELECT /;
// 面向 API / AI 客户端的描述与文档（不是本应用界面）：MCP 工具 schema、REST/OpenAPI 描述、
// prompts 正文，以及 Rust 词表本体（那里的中文是键，左侧那一列）
const EXCLUDE_FILE = [
  /src-tauri\/src\/i18n\.rs$/,
  /src-tauri\/src\/mcp\/tools\.rs$/,
  /src-tauri\/src\/mcp\/api\.rs$/,
  /src-tauri\/src\/mcp\/protocol\.rs$/,
];

function* rustStringLiterals(text) {
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && text[i + 1] === "/") {           // 行注释
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {           // 块注释（含嵌套）
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "\n") line++;
        else if (text[i] === "/" && text[i + 1] === "*") { depth++; i++; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth--; i++; }
        i++;
      }
      continue;
    }
    if (c === "r" && (text[i + 1] === '"' || text[i + 1] === "#")) {  // raw string：整块跳过
      let j = i + 1;
      let hashes = 0;
      while (text[j] === "#") { hashes++; j++; }
      if (text[j] === '"') {
        const close = `"${"#".repeat(hashes)}`;
        const end = text.indexOf(close, j + 1);
        const stop = end < 0 ? n : end + close.length;
        line += text.slice(i, stop).split("\n").length - 1;
        i = stop;
        continue;
      }
    }
    if (c === "'") {                                  // 字符字面量（生命周期只跳一个字符）
      const charLit = /^'(?:\\.|[^\\'])'/.exec(text.slice(i));
      i += charLit ? charLit[0].length : 1;
      continue;
    }
    if (c === '"') {                                  // 普通字符串
      const startLine = line;
      let j = i + 1;
      let raw = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") {
          // 转义：`\<换行>` 是 Rust 的续行，**行号必须照常 +1**，否则后面所有串
          // 的行号整体偏移，判定会张冠李戴（把日志当界面文案，或反之）
          if (text[j + 1] === "\n") line++;
          raw += text[j] + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (text[j] === "\n") line++;
        raw += text[j];
        j++;
      }
      yield { raw, startLine, endLine: line };
      i = j + 1;
      continue;
    }
    i++;
  }
}

for (const file of walk(path.join(ROOT, "src-tauri/src"), [".rs"], ["target", "gen"])) {
  if (EXCLUDE_FILE.some((re) => re.test(file))) continue;
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  // 测试断言不是给用户看的（#[cfg(test)] 到下一个顶层项或文件尾）
  const testStarts = [...text.matchAll(/^#\[cfg\(test\)\]|^mod tests\b/gm)].map(
    (m) => text.slice(0, m.index).split("\n").length,
  );
  const inTests = (ln) => testStarts.some((s) => ln > s);

  /** 字符串所在「语句」的行区间：向上找到上一条以 ; { } 结尾（或空行）的行 */
  const statement = (from, to) => {
    let start = from;
    for (let ln = from - 1; ln >= 1 && from - ln <= 12; ln--) {
      const t = (lines[ln - 1] ?? "").trim();
      if (!t || /[;{}]$/.test(t) || t.startsWith("//")) break;
      start = ln;
    }
    return lines.slice(start - 1, to).join("\n");
  };

  for (const { raw, startLine, endLine } of rustStringLiterals(text)) {
    if (inTests(startLine)) continue;
    const stmt = statement(startLine, endLine);
    if (NOT_VISIBLE_SHAPE.test(stmt) || !VISIBLE_SHAPE.test(stmt)) continue;
    const msg = unescapeRs(raw);
    // 后端消息的精确查询先查 EN_US 再查 EN_US_BACKEND（见 i18n.ts 的 trMsgDeep），
    // 所以任一张表里有就算翻到了
    if (hasCJK(msg) && !BACKEND.has(msg) && !UI.has(msg) && !backendMissing.has(msg)) {
      backendMissing.set(msg, `${rel}:${startLine}`);
    }
  }
}

// ---- Rust 系统级文案（i18n.rs）镜像：后端消息会嵌这些标签，前端表必须认得出 ----
const i18nRs = path.join(ROOT, "src-tauri/src/i18n.rs");
const rsPairs = [...fs.readFileSync(i18nRs, "utf8").matchAll(
  /^\s*"((?:[^"\\]|\\.)*)"\s*=>\s*"((?:[^"\\]|\\.)*)",/gm,
)].map((m) => [m[1], m[2]]);
const mirrorMissing = rsPairs.filter(([zh]) => !UI.has(zh) && !BACKEND.has(zh));
const mirrorDrift = rsPairs.filter(([zh, en]) => {
  const v = uiTable.get(zh) ?? backendTable.get(zh);
  return v && v !== en;
});

// ---------------------------------------------------------------- 报告

const missingUI = [
  ...[...trUsed].filter(([k]) => !UI.has(k) && !BACKEND.has(k)),
  ...[...trMsgUsed].filter(([k]) => !UI.has(k) && !BACKEND.has(k) && !trUsed.has(k)),
];
const misplacedUI = [...trUsed].filter(([k]) => !UI.has(k) && BACKEND.has(k));
const orphans = [...UI].filter((k) => !trUsed.has(k) && !trMsgUsed.has(k));

const line = (label, n) => `${n === 0 ? "✅" : "❌"} ${label}: ${n}`;
console.log(line("界面缺失（英文界面会显示中文）", missingUI.length));
console.log(line("界面放错表（写进了 EN_US_BACKEND，tr 查不到）", misplacedUI.length));
console.log(line("后端缺失（英文界面会弹中文消息）", backendMissing.size));
console.log(line("Rust 词表没镜像进前端表（嵌套回译会漏词）", mirrorMissing.length));
console.log(`ℹ️  同词不同译（托盘 vs 界面，仅供统一口径）: ${mirrorDrift.length}`);
console.log(`ℹ️  孤儿词条（EN_US 里没有 tr 字面量在用，多为间接取词或文案改名，无害）: ${orphans.length}`);
console.log(
  `ℹ️  词条规模：EN_US ${UI.size} 条 / EN_US_BACKEND ${BACKEND.size} 条；` +
    `tr() 字面量键 ${trUsed.size} 个 + trMsg() 字面量键 ${trMsgUsed.size} 个`,
);

const detail = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n--- ${title} ---`);
  for (const [k, where] of rows.slice(0, 40)) console.log(`${where}\n  「${k}」`);
  if (rows.length > 40) console.log(`… 其余 ${rows.length - 40} 条省略`);
};
detail("界面缺失", missingUI);
detail("界面放错表", misplacedUI);
detail("后端缺失", [...backendMissing]);
detail("Rust 词表缺镜像", mirrorMissing);
if (mirrorDrift.length) {
  console.log("\n--- 同词不同译（不报错，建议统一）---");
  for (const [zh, en] of mirrorDrift) {
    console.log(`「${zh}」\n  托盘/后端: ${en}\n  界面表:   ${uiTable.get(zh) ?? backendTable.get(zh)}`);
  }
}

process.exit(
  missingUI.length + misplacedUI.length + backendMissing.size + mirrorMissing.length === 0 ? 0 : 1,
);
