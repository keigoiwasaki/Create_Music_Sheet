# Audiveris の配置手順

このアプリは楽譜PDFの自動認識(OMR)に [Audiveris](https://github.com/Audiveris/audiveris) を使用します。ライセンスはAGPL-3.0です。

現在のAudiverisの配布形態はOS別インストーラー(.dmg / .deb / .msi)のみで、インストーラー自身に必要なJavaランタイムが同梱されているため、別途Javaをインストールする必要はありません。

## macOSでの手順

1. [Audiveris Releases](https://github.com/Audiveris/audiveris/releases) から `Audiveris-<version>-macosx-<arm64|x86_64>.dmg` をダウンロード
   (`gh release download <version> -R Audiveris/audiveris -p "Audiveris-*-macosx-$(uname -m).dmg"` でも取得可能)
2. dmgをマウントして `Audiveris.app` をこの `vendor/audiveris/` 直下にコピーする:
   ```
   hdiutil attach Audiveris-<version>-macosx-<arch>.dmg -nobrowse
   ditto "/Volumes/Audiveris/Audiveris.app" vendor/audiveris/Audiveris.app
   hdiutil detach "/Volumes/Audiveris"
   ```
3. 最終的に `vendor/audiveris/Audiveris.app/Contents/MacOS/Audiveris` が存在すればOK。アプリ起動時に自動検出されます。

## Windows/Linuxでの手順

- Windows: `.msi` をインストールし、インストール先(既定 `C:\Program Files\Audiveris`)の `bin\Audiveris.bat` 相当を `vendor/audiveris/bin/Audiveris.bat` として配置するか、`vendor/audiveris/` 配下にインストールディレクトリの中身をコピーする
- Linux: `.deb` をインストールし、`/opt/audiveris/bin/Audiveris` 相当を `vendor/audiveris/bin/Audiveris` として配置する

いずれの場合も、`vendor/audiveris/bin/Audiveris`(またはWindowsは`bin/Audiveris.bat`)が存在すれば自動検出されます。

## 動作確認

```
vendor/audiveris/Audiveris.app/Contents/MacOS/Audiveris -batch -export -output /tmp/omr-test -- /path/to/sample.pdf
```

コマンドが正常終了し、`/tmp/omr-test` 内に `.mxl` ファイルが生成されればOKです。
