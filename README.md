# 楽譜ドレミ表示アプリ

楽譜PDFを読み込むと、Audiveris(OMR)でMusicXMLに変換し、OpenSheetMusicDisplayで再描画した楽譜の各音符の真上にドレミ(固定ド、カタカナ)を自動で表示するElectronデスクトップアプリです。

## セットアップ

```
npm install
```

自動認識(OMR)を使うには [vendor/audiveris/README.md](vendor/audiveris/README.md) の手順に従ってAudiverisを配置してください。未配置でも「サンプルを表示」ボタンで描画・ラベル機能のみ確認できます。

## 起動

```
npm run dev
```

## テスト

```
npm test          # ドレミ変換ロジックの単体テスト
npx tsc --noEmit  # 型チェック
```

## ビルド

```
npm run build
```

## 既知の注意点

- **VS Codeの統合ターミナルで`ELECTRON_RUN_AS_NODE=1`が設定されていると起動に失敗します**(`ipcMain`が undefined になるエラー)。その場合は `unset ELECTRON_RUN_AS_NODE && npm run dev` のように環境変数を外してから実行してください。
- OMR(Audiveris)の認識精度は楽譜のスキャン品質に依存し、誤認識が発生することがあります。
- 現状は固定ド(絶対音名ベース)のみ対応。移動ドは未対応です。
