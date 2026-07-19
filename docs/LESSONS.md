# LESSONS

本專案踩過的坑。格式見 `.claude/rules/kit-evolution.md`。

### 2026-07-20 宣稱「檔案在版控裡」而沒有查證，該檔其實是 gitignored
- Context: 討論 `generate-urls.mjs` 增量更新機制時，評估「不做差異報告、
  改用 `git diff` 看變化」這個方案。
- Error: 逐字原話——「`urls-virtual_kaf.txt` 已在版控中，重生成後 `git diff`
  就是差異報告」。實際上 `.gitignore` 第 6 行就列著它。一句 `git ls-files`
  可以驗證，但沒跑。這個錯誤讓一個不可行的方案在設計討論裡被當成可行選項。
- Solution: 事後 `git ls-files urls-virtual_kaf.txt` 回傳空，才發現。已在
  README 的「半年後最容易忘的事」記下該檔未受版控的後果。
- Rule: 主張某檔案受版控／某指令存在／某路徑有效之前，先跑一次驗證指令
  （`git ls-files` / `ls` / `--help`），不要從記憶或直覺推斷。

### 2026-07-20 yt-dlp 對同一支影片回傳兩種語言的標題
- Context: 用 `--flat-playlist` 掃 `@virtual_kaf` 產生清單，再對照 Supabase
  已入庫的資料。
- Error: 頻道掃描回 `KAF #171 - School Wars`，實際 ingest 時
  `fetchMetadata` 回「花譜 ＃171「学園戦線」【オリジナルMV】」。同一支影片
  （`AQTpvFureqs`），兩個標題完全不同——YouTube 多語言標題功能，
  flat-playlist 給的是本地化顯示名，單片查詢給的是原始標題。
- Solution: 對帳一律以 video_id 為準，不要用標題比對。入庫的是日文標題。
- Rule: 跨資料源比對 YouTube 影片時只用 video_id 當 key；標題只拿來給人看，
  永不當識別依據。
