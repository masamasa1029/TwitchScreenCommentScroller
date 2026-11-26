# Twitch Screen Comment Scroller

Twitch のチャットを、動画の上にニコニコ風に流す Tampermonkey スクリプトです。
現行バージョンは v0.8.1 です。

## 特徴

- Canvas 1枚 + スプライト描画の低負荷設計。消去はコメントがいる行（レーン）の帯だけなので、毎フレーム全面を描き直しません
- アニメーションエモート対応（ImageDecoder でフレームをデコード、最大120フレーム。失敗したら静止画にフォールバック）
- チャットを折りたたんでいる間もコメントが流れるよう、初期化のプライム処理入り
- 動画部分のリサイズでは流れ中のコメントを引き継ぎます（設定変更時は全消去）
- 動画の上下端からマージンを開ける設定（上下マージン）入り。一番上・一番下のコメントが画面端に張り付きません
- レーンが埋まっているときの挙動を選べます（捨てる／一番早く空くレーンへ重ねて流す）
- 設定は GM ストレージに自動保存

## インストール

1. Tampermonkey を入れたブラウザで [TwitchScreenCommentScroller.user.js](https://raw.githubusercontent.com/masamasa1029/TwitchScreenCommentScroller/main/TwitchScreenCommentScroller.user.js) を開くと、インストール画面が出ます
2. Twitch の配信ページを開けば自動で動き出します

この URL からインストールすると、以後は Tampermonkey の自動更新で GitHub 上の最新版に追随します。

## 設定

Tampermonkey のメニューから「コメントスクロール設定」を開きます。
文字色・縁取り・透明度・フォントサイズ・行数・流れる速さ・スタンプ表示/アニメーション・NG ワードなどが変更できます。

## ファイル

- `TwitchScreenCommentScroller.user.js` — 本体
- `tools/smoke.js` — Node のスタブ環境で本体を読み込む検証用スクリプト

## 仕様メモ

- 配信が止まったり終わったりした後も、コメントは実時間ベースで流れ続けます（意図した仕様です）

## クレジット

本スクリプトは、knoa (kona) さんの [Twitch Screen Comment Scroller](https://greasyfork.org/ja/scripts/376225) を原作とし、2023 年の Twitch 仕様変更に対応した改修版 [Twitch Screen Comment Scroller(fix)](https://greasyfork.org/scripts/458513-twitch-screen-comment-scroller-fix)（page.loupe）を土台に改変したものです。設計と土台は原作・改修版から受け継いでいます。
