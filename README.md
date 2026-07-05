# song-analysis

> 花譜（KAF）cover 曲的 YouTube ingest + 音訊分析 pipeline，產出每幀
> spectrum + 歌詞資料到 Supabase，供 kaf-observatory 的 3D 視覺化消費。
> **私人 repo，這份 README 是寫給未來的我**——隔幾個月回來能 30 秒內重啟。
>
> Stack 一行：Node.js ≥20 (ESM) · Meyda · Supabase (Postgres + Storage) · yt-dlp（外部 CLI）。

---

## 🚀 30 秒重啟

```bash
npm install
# 確認 .env 存在（見 .env.example：SUPABASE_URL / SUPABASE_SERVICE_KEY）
# 確認 yt-dlp 在 PATH（不在 package.json 裡，要另外裝/更新：pip install -U yt-dlp）
node analyzer.mjs --url "<youtube-url>" --dry-run   # 單曲試跑（不寫 DB）
```

## 主要功能

1. **單曲 ingest**：`node analyzer.mjs --url "<url>" [--genre <tag>] [--force]`
   —— yt-dlp 抓音訊+字幕 → Meyda 每幀 spectrum → binary blob + 歌詞寫入
   Supabase（`Songs` 表 + `song-blobs` bucket）。
2. **整夜批次**：`node batch.mjs urls.txt [--sleep <sec>]`（含限流退避）。
3. **頻道掃描**：`node generate-urls.mjs` 用 yt-dlp 掃 `@virtual_kaf` 產出 urls.txt。
4. **離線 FFT 重放**：`src/clock_analysis.mjs` 是前端 live audio engine 的離線移植。
5. **曲名正規化**：`src/title.mjs` 處理花譜 cover 標題（前端 A-Z 索引用）；
   `node lint-titles.mjs` dry-run 檢查。

## 測試

```bash
npm test   # node --test，目前覆蓋 src/title.test.mjs
```

## 相關 repo

- **kaf-observatory** — 前端消費者（3D desk / Wall Clock 視覺化）。資料契約見
  本 repo 的 `DATA_CONTRACTS.md` 與 `CLOCK_ANALYSIS_HANDOVER.md`。
- **kaf-posts-ingest** — 同宇宙的另一條後端（X/Twitter RSS + 翻譯，互不依賴）。

## AI 接手

專案裝有 multi-agent kit（v4.2）：開 `claude` 即載入工作流規則，
專案事實見 `CLAUDE.md`。
