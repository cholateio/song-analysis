# song-analysis

> CLAUDE.md（kit v4.2）。本檔只放專案內容；workflow / 派工 / review 規則由
> `.claude/rules/` 自動載入（kit-owned），見檔尾「Multi-agent kit」路由表。

## Project goal

花譜（KAF）cover 曲的 YouTube ingest + 音訊分析 pipeline：用 yt-dlp 抓音訊與
字幕 → Meyda 做每幀 spectrum 分析 → 打包成 binary blob 連同歌詞寫入 Supabase
（`Songs` 表 + `song-blobs` storage bucket），供 3D 前端視覺化消費。前端消費者
為 **kaf-observatory**（本 repo 的 `CLOCK_ANALYSIS_HANDOVER.md` 對應其
`docs/reference/clock-analysis-handover.md`；歷史名 virtual-music-clock）。

## Stack

- Language: Node.js ≥20（ESM，`"type": "module"`）
- 核心依賴: `meyda`（spectrum 特徵）、`@supabase/supabase-js`、`dotenv`、`minimist`
- 外部 CLI 依賴（不在 package.json）: **yt-dlp**（`src/youtube.mjs` 經 child_process 呼叫）
- Datastore: Supabase Postgres `Songs` 表 + Storage bucket `song-blobs`（DDL 見 `supabase-schema.sql`）
- Run: `node analyzer.mjs --url "<youtube-url>" [--genre <tag>] [--force] [--dry-run]`
- Batch: `node batch.mjs urls.txt [--sleep <sec>]`（無人值守整夜批次，含限流退避）
- Test: `npm test`（node --test，跑 `src/title.test.mjs`）

## File layout

- `analyzer.mjs` — CLI 進入點（單曲 ingest）
- `batch.mjs` — 依序批次跑 urls.txt
- `generate-urls.mjs` — 用 yt-dlp 掃 YouTube 頻道（`@virtual_kaf`）產出 urls
- `lint-titles.mjs` — 標題 dry-run 檢查
- `src/youtube.mjs` — yt-dlp wrapper；`src/audio.mjs` — Meyda spectrum 抽取
- `src/clock_analysis.mjs` — 前端 live FFT 的離線移植版
- `src/binary_pack.mjs` — binary blob 打包；`src/db.mjs` — Supabase client / upsert
- `src/title.mjs`（+ .test.mjs）— 花譜曲名正規化（前端 A-Z 索引用）
- `supabase-schema.sql` — DB DDL；`DATA_CONTRACTS.md` / `CLOCK_ANALYSIS_HANDOVER.md` /
  `LIP_SYNC_PLAN.md` — 給前端的交接文件
- `docs/specs/` — spec 入口（目前空）

## Project-specific constraints（禁區與硬規則）

（目前無。踩到坑再累積；路徑型禁區同步加進 `.claude/protected-paths`。）

## Multi-agent kit

workflow / 派工 / review / 判斷規則由 `.claude/rules/` 每 session 自動載入
（kit-owned，由 kit repo 的 `init.sh --update` 維護，不要在本專案裡改）。
情境對應的按需文件：

| 情境 | 讀這裡 |
|------|--------|
| 卡關了 / 想宣告完成 / 猶豫要不要問 user | `.claude/docs/judgment-matrix.md` |
| 要派工給 subagent | `/kit-dispatch` skill（五種模板） |
| 要做 UI / 設計 schema / 同一 bug 連續卡 / 引入外部服務 / 定架構 | `.claude/docs/verification-signals.md`（命中哪節讀哪節） |
| 要記教訓 / 查歷史教訓 / 想改 harness 檔案 | `docs/LESSONS.md`（append；動大手術前先掃一眼）/ kit-evolution 規則（自動已載入） |
