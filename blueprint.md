# YouTube 歌詞與音訊分析腳本 (Backend CLI Script) 規格書

## 1. 資料庫設計 (Supabase Table: music_analysis_vault)
為了極大化儲存效率，我們在 JSON 中使用縮寫鍵名（例如 s 代表 start），這在處理萬級數據時能節省顯著空間。

**欄位名型別說明**
- video_id: TEXT，(PK)YouTube 影片唯一 ID。
- title: TEXT，歌曲標題（自動從影片標題抓取）。
- artist: TEXT，頻道名稱或歌手。
- metadata: JSONB，包含 bpm, duration, sample_rate 等全域參數。
- lyrics: JSONB，字幕陣列：[{s: 開始, d: 持續, t: 文本}]。
- analysis: JSONB，頻譜數據：[{t: 秒數, v: [低, 中, 高], b: 節拍}]。
- updated_at: TIMESTAMPTZ，最後更新時間。

## 2. 環境依賴 (Dependencies)
ytdl-core: 獲取影片資訊與下載音訊流。
youtube-transcript: 抓取 YouTube 字幕軌。
@supabase/supabase-js: 與資料庫通訊。
fluent-ffmpeg: 呼叫系統 ffmpeg 處理音訊。
web-audio-api (或 node-canvas-audio): 用於在 Node 環境模擬 FFT 分析。
meyda: 強大的音訊特徵提取庫（支援 RMS, Energy, SpectralRolloff 等）。

## 3. 核心處理邏輯 (The Pipeline)
#### 第一階段：元數據與字幕抓取
解析 ID：驗證輸入網址並提取 videoId。
獲取資訊：使用 ytdl.getInfo() 抓取標題、時長。
抓取字幕：優先抓取 lang: 'ja'。若無官方字幕，抓取自動生成字幕，若都無字幕，結束此輪運行。
資料轉換：將 offset 轉換為以秒為單位的 float。

#### 第二階段：音訊分析 (FFT & Peak Detection)
串流處理：透過 ytdl 下載 audioonly 串流，並 pipeline 給 ffmpeg 轉為 wav 格式（以便分析）。
頻譜取樣：設定分析頻率為 30Hz (每33.3ms 採樣一次)，確保與瀏覽器 requestAnimationFrame 同步。
定義頻段：Bass: 20 - 250 Hz (視覺震動的主力)。Mid: 250 - 4000 Hz (人聲與主旋律)。High: 4000 - 15000 Hz (高頻亮點)。
節拍檢測 (Beat Detection)：計算 Spectral Flux (頻譜變化量)。當能量瞬間激增且超過動態閾值時，標記 b: true。

#### 第三階段：資料封裝與上傳
資料降噪：對頻譜數值進行歸一化處理 (0.0 ~ 1.0)，並四捨五入至小數點後三位。
Upsert：將結果寫入 Supabase。

## 4. 資料結構範例 (JSON Schema)
```JSON
{
  "video_id": "kLLP033jBs8",
  "title": "YOASOBI - 怪物 (Kaibutsu)",
  "metadata": {
    "bpm": 170,
    "duration": 227.5,
    "fps": 60
  },
  "lyrics": [
    { "s": 12.45, "d": 2.1, "t": "Ah, 素晴らしき世界に今日も乾杯" },
    { "s": 14.80, "d": 1.5, "t": "街に溢れるノイズが心地いい" }
  ],
  "analysis": [
    { "t": 0.016, "v": [0.12, 0.05, 0.01], "b": false },
    { "t": 0.033, "v": [0.15, 0.06, 0.02], "b": false },
    { "t": 0.500, "v": [0.98, 0.45, 0.21], "b": true },
    { "t": 0.516, "v": [0.85, 0.40, 0.18], "b": false }
  ]
}
```

## 5. 技術細節與效能考慮 (Senior Dev Notes)
無檔案化處理 (In-Memory Processing)：
音訊分析時，盡量使用 Stream 處理，避免在磁碟寫入大型臨時音檔。使用 ffmpeg 的 pipe:1 直接輸出給分析器。
BPM 修正：YouTube 自動生成的資訊中通常沒有 BPM。建議引入 music-tempo 庫，透過分析整首歌的節奏點（Onsets）來反推一個穩定的平均 BPM，這對前端視覺化同步非常有用。
資料壓縮優化：如果 analysis 陣列太長導致 Supabase 報錯（單一 Row 有 10MB 限制），可以考慮將 v (Vector) 拍平成一個大字串，或是在 Node.js 端先用 zlib 壓縮 JSON 字串，存入一個 BYTEA 欄位。

## 6. 如何執行這個腳本
預期執行命令：
```Bash
node analyzer.mjs --url "https://..." --lang "ja"
```
這份規格書完整定義了「資料如何產生」與「資料如何儲存」。
你不需要煩惱前端，我已經將 analysis 數據結構最佳化，讓你的 Three.js 邏輯只要拿到這份 JSON，就能透過 currentTime 秒數直接對應到索引值：
const index = Math.floor(currentTime * metadata.fps);