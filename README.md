# M Battle

方塊對戰網頁遊戲：單人（含 AI 四種難度）＋線上對戰。
部署在 Cloudflare Workers，網址 https://game.momowinwin.com

## 結構

```
public/index.html   遊戲本體（單一檔案）
src/index.js        Worker：提供網頁，/ws/<房號> 轉給對戰房間（Durable Object）
wrangler.jsonc      Cloudflare 設定（含自訂網域 game.momowinwin.com）
```

## 對戰連線

- 玩家輸入同一個房號 → 前端連 `wss://game.momowinwin.com/ws/bb-<房號>`
- 每個房號對應一個 `Room` Durable Object（SQLite 版，免費方案可用），每房上限 6 人
- 訊息：`pres`（玩家狀態：盤面、KO、消行、高度…）、`emit`（攻擊 atk、開局 go）
- 邀請連結：`https://game.momowinwin.com/?r=<房號>`

## 本機測試

```
npm install
npx wrangler dev
```
打開 http://localhost:8787 ，開兩個分頁輸入同房號即可對戰。

## 部署

推到 GitHub main 分支後，Cloudflare（Workers Builds）會自動部署。
手動部署：`npx wrangler deploy`
