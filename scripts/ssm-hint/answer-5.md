スクリプトの流れを図にします。各ステップの意味をまとめます。

<img src="db_tunnel_script_flow.png" />

---

**① スクリプト起動 — 入力検証**
`--instance` と `--secret` が渡されているか確認します。片方でも欠けたらその場で終了。環境変数からも読めるようにしてあるので、`.env.tunnel` を `source` してから呼んでも OK。

**② 依存コマンド確認**
`aws` と `session-manager-plugin` が `PATH` に存在するか `which` で確認します。Plugin が入っていないと SSM セッション自体が張れないため、早期に弾きます。

**③ AWS 認証確認**
`sts get-caller-identity` を呼んで実際に AWS と通信できるか確認します。プロファイルが間違っていたり期限切れトークンを使っている場合はここで落ちます。

**④a / ④b — 並列チェック**
`Promise.all` で Secrets Manager の取得と EC2 の状態確認を同時に走らせます。直列にすると待ち時間が2倍になるため並列化しています。Secrets Manager からは `host` `port` `username` `password` `dbname` を取得し、必須キーが揃っているか検証します。EC2 は `running` でないと SSM が繋がらないため状態確認しています。

**⑤ ローカル環境チェック**
ポート競合（`15432` が他プロセスに使われていないか）と多重起動防止（`~/.db-tunnel.pid` の有無と PID の生存確認）を行います。

**⑥ 接続情報の表示**
取得した Secret の内容を画面に出力します。パスワードは `****` でマスクしつつ、別ターミナルで貼り付けられる形の `psql` コマンドは `PGPASSWORD='...'` 付きで平文表示します。

**⑦ SSM ポートフォワーディング開始**
`aws ssm start-session` に `AWS-StartPortForwardingSessionToRemoteHost` を渡して起動します。これにより `127.0.0.1:15432` へのアクセスが Aurora の `5432` に転送されます。このプロセスはバックグラウンドに回さず、スクリプト自体が待機し続けます。

**⑧ トンネル稼働中**
psql や TablePlus などから `127.0.0.1:15432` に接続できる状態です。Ctrl+C を待ちます。

**⑨ cleanup() 実行**
3つのルートで到達します。`SIGINT`（Ctrl+C）、`SIGTERM`（`kill` コマンド）、`SIGHUP`（ターミナル切断）です。まず SSM プロセスに `SIGTERM` を送り、3秒経っても死ななければ `SIGKILL` で強制終了します。その後 `ssm describe-sessions` で残存セッションを検索し `terminate-session` で明示的に閉じます。これをしないと AWS 側にゾンビセッションが残ります。

**⑩ PID ファイル削除 & exit**
`~/.db-tunnel.pid` を消してから `process.exit(0)` します。これを最後にすることで、途中でクリーンアップに失敗しても「次回起動時に PID ファイルを消してリトライ」というフローが成立します。