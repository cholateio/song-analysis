# song-analysis

> 花譜（KAF）cover 曲的 YouTube ingest + 音訊分析 pipeline：抓音訊與字幕 →
> Meyda 每幀 spectrum → binary blob + 歌詞寫進 Supabase，供 **kaf-observatory**
> 的 3D 視覺化消費。**私人 repo，這份 README 是寫給未來的我**——隔幾個月回來
> 能 30 秒內重啟、想起它怎麼運作、以及怎麼叫 AI 接手。
>
> Stack 一行：Node.js ≥20 (ESM) · Meyda · Supabase (Postgres + Storage) ·
> yt-dlp + ffmpeg（兩個都是外部 CLI，不在 package.json 裡）。

---

## 🚀 30 秒重啟

```bash
pnpm install
# 確認 .env 存在（見 .env.example：SUPABASE_URL / SUPABASE_SERVICE_KEY）
# 確認 yt-dlp 與 ffmpeg 都在 PATH（pip install -U yt-dlp / apt install ffmpeg）
node analyzer.mjs --url "<youtube-url>" --dry-run   # 單曲試跑，不寫 DB
```

**只要記上面最後那一行。** 拿掉 `--dry-run` 就是正式 ingest，其餘都是例外才用：

| 指令 | 用途 |
|------|------|
| `node analyzer.mjs --url "<url>"` | 單曲 ingest（音訊分析 + 字幕 → Supabase） |
| `node analyzer.mjs --url "<url>" --genre <tag>` | 順便打分類標籤（`cover` / `album1` / `live`…） |
| `node analyzer.mjs --url "<url>" --force` | 已 ingest 過的 video_id 強制重跑 |
| `node analyzer.mjs --url "<url>" --dry-run` | 跑完整 pipeline 但跳過 Supabase 寫入 |
| `node analyzer.mjs --url "<url>" --list-captions` | 只列這支影片有哪些字幕軌，然後結束 |
| `node analyzer.mjs --url "<url>" --skip-lyrics` | 完全不抓字幕（YouTube 在限流時用） |
| `node generate-urls.mjs` | 掃 `@virtual_kaf` 頻道 → 產出 `urls-virtual_kaf.txt` |
| `node lint-titles.mjs urls-virtual_kaf.txt` | 標題正規化 dry-run 檢查（不動 DB） |
| `node batch.mjs urls-virtual_kaf.txt` | 依序批次 ingest（整夜無人值守用） |
| `pnpm test` | 唯一的 quality gate（node --test，覆蓋 `src/title.mjs` 與 `generate-urls.mjs` 的過濾/白名單） |

灌一批新歌的標準順序：`generate-urls` → `lint-titles`（看標題正規化有沒有走鐘）
→ `batch`。

## 🎛️ batch 的限流參數（唯二要決定的東西）

| flag | 預設 | 說明 |
|------|------|------|
| `--sleep <sec>` | `15` | 每首之間睡幾秒，帶 ±jitter。填 `0` 關閉 |
| `--no-retry` | 關 | 預設**失敗會睡 90s 自動重試一次**；加這個 flag 改成失敗即放棄 |

最終仍失敗的 URL 會 append 到 cwd 的 `batch-failed-<timestamp>.txt`，可直接
`node batch.mjs batch-failed-xxx.txt --force` 補跑，不用手改原清單。
任何不認得的 flag 會原樣轉發給 `analyzer.mjs`。

`urls.txt` 格式：一行一個 URL，URL 後面用空白接一個 genre tag（選填）；
空行與 `#` 開頭的行跳過。

```
https://www.youtube.com/watch?v=jpwy7kP8Pps cover
https://youtu.be/abc12345678
# 這行會被略過
```

## 🔑 憑證

`.env`（gitignored，見 `.env.example`）兩個變數，缺任一個 analyzer 會 fail fast：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` —— **service-role key，不是 anon key**；upsert 要繞過 RLS。

`--dry-run` 與 `--list-captions` 不碰 DB，所以沒有 `.env` 也能跑。

## ☁️ 部署

- 無部署——本機 CLI 工具（WSL）。
- 輸出：Supabase `Songs` 表一列 + `song-blobs` bucket 兩個 blob
  （`analysis/<video_id>.bin` 與 `clock/<video_id>.bin`）。
- 消費端是 kaf-observatory，它只**讀** Supabase。

---

## 🧠 半年後最容易忘的事

- **ffmpeg 是隱性硬依賴**：preflight 同時檢查 yt-dlp 與 ffmpeg，少一個直接
  退出。loudness 的 LRA 值就是從 ffmpeg 的 ebur128 stderr 撈出來的。
- **12 分鐘硬上限**：`MAX_DURATION_SEC`（`analyzer.mjs:13`）超過就 fail，
  要收長片得自己改那一行。
- **只用官方字幕**：只認 human-uploaded 的 `ja` 與 `zh-TW`，各存一欄
  （`lyrics_jp` / `lyrics_tw`）。auto-transcribed 永不採用（唱歌的自動字幕品質
  太差）。兩軌都沒有時 **lyrics 留 null，音訊分析照樣存**——那不算失敗。
- **重跑要 `--force`**：video_id 已存在就直接跳過，安靜地什麼都不做。
- **`generate-urls.mjs` 的預設輸出是 `urls-virtual_kaf.txt`**，不是 `urls.txt`。
- **`urls-virtual_kaf.txt` 是 gitignored 的純產物，`generate-urls.mjs` 才是真理源**
  （全量覆蓋寫檔）。過濾的例外兩個方向都寫在該檔的兩份 id 清單裡：
  - `KEEP_IDS`（4 支 Live Ver.）——頻道上沒有 studio 版，被 live 過濾刷掉
    等於該曲從資料庫消失，所以強制保留。
  - `DROP_IDS`（10 支御礼／新年／記念類告知影片）——長度與標題都通得過過濾
    但不是歌，不擋的話每次重生成都會復活，然後被 batch 當歌灌進 DB。

  **永遠不要手動編輯 txt**：手加的行下次重生成就沒了，手刪的行下次重生成會
  回來。要增減一律改 `KEEP_IDS` / `DROP_IDS`，改完 `pnpm test` 會檢查兩份
  清單不重疊。
- **同一支影片有兩個標題**：yt-dlp 掃頻道（`--flat-playlist`）拿到的是英文標題，
  單片 `fetchMetadata` 拿到的是日文標題（YouTube 多語言標題功能）。入庫的是日文那個。
  拿頻道清單跟 DB 對帳時會對不起來——2026-07-20 實例：頻道顯示
  `KAF #171 - School Wars`，入庫是「花譜 ＃171「学園戦線」」。
- **版本號有兩個且獨立**：blob 的 `BIN_VERSION` 目前 1，row 的
  `metadata.schemaVersion` 目前 2。改 binary layout 要 bump 並在同一個 commit
  更新 `docs/reference/data-contracts.md`。
- **`src/clock_analysis.mjs` 是前端 live FFT 的離線移植版**——它跟前端那份要
  一起改，不然視覺化會對不上。

## 📚 文件地圖

| 檔案 | 內容 |
|------|------|
| `CLAUDE.md` | AI 協作規則 + 本專案事實（stack / file layout / constraints） |
| `docs/reference/data-contracts.md` | `Songs` 表 + binary blob 的**權威格式規格** |
| `docs/reference/clock-analysis-handover.md` | clock analysis 離線移植的交接說明 |
| `docs/plans/lip-sync-pipeline.md` | 唇形同步三階段計畫，**尚未實作**（下一步） |
| `docs/specs/` | spec 入口（目前空） |
| `supabase-schema.sql` | DB DDL |

## 🔗 相關 repo

- **kaf-observatory** —— 前端消費者（3D desk / Wall Clock 視覺化）。資料契約以
  本 repo 的 `docs/reference/` 為準。
- **kaf-posts-ingest** —— 同宇宙的另一條後端（X/Twitter RSS + 翻譯，互不依賴）。

---

## 🤖 叫 AI 接手

專案裝有 multi-agent kit（版本見 `.claude/kit-version`）：開 `claude` 即載入
workflow 規則，專案事實見 `CLAUDE.md`。

**回來第一句（複習 prompt）**
```
先讀 CLAUDE.md 和 docs/reference/data-contracts.md，然後用三五句話跟我複習：
這個專案在做什麼、有哪些必知 constraints、目前有沒有半成品或 TODO。
先不要改任何檔案。
```

**kit 更新**（拉取 kit repo 最新的 workflow rules / templates）：
```bash
~/.multi-agent-kit/init.sh . --update
```
