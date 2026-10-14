# homr の導入手順(実験的エンジン)

このアプリは、既定のAudiverisとは別に、[homr](https://github.com/liebharc/homr)(AGPL-3.0)という無料・ローカル動作のOMRエンジンを**実験的な選択肢**として組み込んでいます。実際にテストしたところ、同じ条件でoemerが片手(右手)をほぼ丸ごと読み落としたのに対し、homrは両手ともバランスよく認識できました。

Audiverisと異なり、homrは:
- **PDFではなく1ページぶんの画像のみ**を入力として受け付けます(公式READMEにはPDF対応の記載がありますが、実際にインストールして試したところ非対応でした。アプリ側でPDFを事前にページ画像化しています)
- ページを複数まとめて渡す機能は未確認のため、アプリは1ページずつ実行しています
- 符頭のピクセル座標そのもの(Audiverisの`.omr`に相当するもの)は出力しません。そのため「元のPDFに正確に重ねる」表示はできず、常に再描画表示(OSMDフォールバック)になります(`--write-staff-positions`で段の位置は書き出せますが、音符1つ1つの座標ではないため今回は未使用)
- Python **3.11または3.12が必要**です(3.10では動きません)

## インストール

**独立したvenvへのインストールを強く推奨します。** グローバル環境を汚染しないためです。

```
# Python 3.11/3.12 が無ければ pyenv などで用意してください
python3.11 -m venv vendor/homr/venv
vendor/homr/venv/bin/pip install --upgrade pip
vendor/homr/venv/bin/pip install "homr[cpu]"
```

GPU(NVIDIA CUDA / AMD ROCm)がある場合は `homr[cpu]` の代わりに `homr[cuda]` / `homr[rocm]` を検討してください。

アプリはこのvenv(`vendor/homr/venv/bin/homr`)を自動では見つけません。`npm run dev`を実行するシェルで、環境変数 `HOMR_BIN` に実行ファイルのフルパスを設定してください:

```
export HOMR_BIN=$(pwd)/vendor/homr/venv/bin/homr
```

## 動作確認

```
vendor/homr/venv/bin/homr --help
```

が正常終了すればアプリから認識されます。初回実行時にモデル(数十MB)が自動ダウンロードされるので、事前に1枚試しておくと安心です:

```
vendor/homr/venv/bin/homr /path/to/sample-page.png
ls /path/to/sample-page.musicxml
```

(入力画像と同じディレクトリに `<画像名>.musicxml` が出力されます。`-o`等の出力先指定オプションはありません。)

## アプリでの使い方

サイドバーの「認識エンジン」で「homr(実験的・低速)」を選んでから「楽譜PDFを開く」を実行してください。複数ページの曲はページごとに順番に処理されるため、曲全体の変換に数十分かかることがあります。
